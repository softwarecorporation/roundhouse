import type { Signal } from "./types.js";
export type { Incident, History, Config, Monitor, Signal } from "./types.js";

export class RoundhouseClient {
  readonly #base: string;
  readonly #token: string;
  constructor({ url, token }: { url: string; token: string }) {
    this.#base = url.replace(/\/$/, "");
    this.#token = token;
  }
  async #request(path: string, body?: unknown, key?: string): Promise<unknown> {
    const headers = new Headers({ authorization: `Bearer ${this.#token}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (key) headers.set("idempotency-key", key);
    const r = await fetch(this.#base + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    if (!r.ok) throw new Error(`Roundhouse HTTP ${r.status}`);
    return r.json();
  }
  // HTTP methods return unknown deliberately: callers may connect to either host version.
  incidents(): Promise<unknown> { return this.#request("/v1/incidents"); }
  history(id: string): Promise<unknown> { return this.#request(`/v1/incidents/${encodeURIComponent(id)}`); }
  event(monitor: string, idempotencyKey: string): Promise<unknown> { return this.#request("/v1/events", { monitor }, idempotencyKey); }
  approve(id: string, action: string): Promise<unknown> { return this.#request(`/v1/incidents/${encodeURIComponent(id)}/approve`, { action }); }
  capture(signals: Signal[]): Promise<unknown> { return this.#request("/v1/telemetry", signals); }
  telemetry(filters: { service?: string; kind?: Signal["kind"]; name?: string; trace_id?: string; since?: string; until?: string } = {}): Promise<unknown> { return this.#request("/v1/telemetry?" + new URLSearchParams(filters)); }
  analytics(filters: { service: string; kind: Signal["kind"]; name: string; since?: string; until?: string; bucket_seconds?: string }): Promise<unknown> { return this.#request("/v1/analytics?" + new URLSearchParams(filters)); }
}
