import type { RegisteredTool } from "./types.js";
import type { WorkspaceStore } from "./workspace.js";

export interface ToolContext {
  monitor: string;
  invocation: string;
  signal: AbortSignal;
  workspace: WorkspaceStore;
  executorToken?: string;
}

/** Adapters are trusted host code, not model-authored plugins. */
export interface ToolAdapter {
  id: string;
  effect: RegisteredTool["effect"];
  validate(options: unknown): void;
  execute(arguments_: unknown, options: unknown, context: ToolContext): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const args = object(value);
  if (Object.keys(args).length !== 1 || typeof args[key] !== "string" || !args[key] || args[key].length > 8192) throw new Error("invalid tool arguments");
  return args[key];
}

function endpoint(value: string, remote = false): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ip = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(remote && loopback && url.protocol === "http:"))) throw new Error("invalid tool endpoint");
  // Public fetch never authorizes literal private/reserved IPs or local/metadata names.
  if (!remote && (loopback || ip.includes(":") || /^\d+(\.\d+){3}$/.test(ip) || /(^|\.)(localhost|local|internal)$/.test(ip) || ip === "metadata.google.internal")) throw new Error("public web fetch requires a configured trusted DNS destination");
  return url;
}

async function responseText(response: Response, limit = 8192): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const bytes: number[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > limit) throw new Error("tool response size limit");
      for (const byte of value) bytes.push(byte);
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

function allowedURLs(options: unknown): string[] {
  const o = object(options);
  if (Object.keys(o).length !== 1 || !Array.isArray(o.allowed_urls) || o.allowed_urls.length < 1 || o.allowed_urls.length > 64) throw new Error("invalid web fetch allowlist");
  return o.allowed_urls.map(value => {
    if (typeof value !== "string" || value.length > 2048) throw new Error("invalid web fetch URL");
    return endpoint(value).href;
  });
}

export class ToolRegistry {
  private readonly adapters = new Map<string, ToolAdapter>();
  register(adapter: ToolAdapter): this {
    if (!adapter.id || this.adapters.has(adapter.id)) throw new Error("duplicate tool adapter");
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  validate(tool: RegisteredTool): void {
    const adapter = this.adapters.get(tool.adapter);
    if (!adapter || tool.effect !== adapter.effect) throw new Error("unavailable tool adapter or mismatched effect");
    adapter.validate(tool.options);
  }
  async execute(tool: RegisteredTool, arguments_: unknown, context: ToolContext): Promise<unknown> {
    this.validate(tool);
    const adapter = this.adapters.get(tool.adapter);
    if (!adapter) throw new Error("unavailable tool adapter");
    context.signal.throwIfAborted();
    return adapter.execute(arguments_, tool.options, context);
  }
}

export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      id: "web_fetch", effect: "read", validate: options => { allowedURLs(options); },
      async execute(args, options, context) {
        const url = endpoint(field(args, "url")).href;
        if (!allowedURLs(options).includes(url)) throw new Error("URL not allowlisted");
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]) });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("tool redirects denied"); }
        return { url, status: response.status, body: await responseText(response), untrusted: true };
      },
    })
    .register({
      id: "virtual_shell", effect: "sandbox", validate: options => { if (Object.keys(object(options)).length) throw new Error("virtual shell takes no host options"); },
      execute: (args, _, context) => context.workspace.shell(context.monitor, field(args, "command"), context.signal),
    })
    .register({
      id: "workspace_history", effect: "read", validate: options => { if (Object.keys(object(options)).length) throw new Error("history takes no options"); },
      async execute(args, _, context) {
        if (Object.keys(object(args)).length) throw new Error("history takes no arguments");
        return { head: context.workspace.head(context.monitor).revision, versions: context.workspace.history(context.monitor) };
      },
    })
    .register({
      id: "workspace_restore", effect: "sandbox", validate: options => { if (Object.keys(object(options)).length) throw new Error("restore takes no options"); },
      async execute(args, _, context) {
        const a = object(args);
        if (Object.keys(a).length !== 2 || typeof a.revision !== "number" || !Number.isSafeInteger(a.revision) || a.revision < 1 || typeof a.expected !== "number" || !Number.isSafeInteger(a.expected) || a.expected < 0) throw new Error("invalid workspace restore");
        return context.workspace.restore(context.monitor, a.revision, a.expected);
      },
    })
    .register({
      id: "remote_exec", effect: "privileged",
      validate(options) {
        const o = object(options);
        if (Object.keys(o).length !== 1 || typeof o.url !== "string") throw new Error("remote execution needs a fixed executor URL");
        endpoint(o.url, true);
      },
      async execute(args, options, context) {
        const command = field(args, "command");
        const o = object(options);
        if (typeof o.url !== "string" || !context.executorToken) throw new Error("executor credential unavailable");
        const response = await fetch(o.url, {
          method: "POST", redirect: "manual", signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
          headers: { authorization: `Bearer ${context.executorToken}`, "content-type": "application/json", "idempotency-key": context.invocation }, body: JSON.stringify({ command }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error("executor rejected or unavailable; reconcile before retry"); }
        return JSON.parse(await responseText(response, 327680));
      },
    });
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("invalid JSON invocation");
  return result;
}

export async function invocationDigest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
