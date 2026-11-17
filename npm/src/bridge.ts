import type { Config, Accepted, Monitor, Call, Signal, RegisteredTool } from "./types.js";

export function bridge(invoke: (input: string) => string) {
  function run(input: unknown): unknown {
    const result: unknown = JSON.parse(invoke(JSON.stringify(input)));
    if (!result || typeof result !== "object") throw new Error("invalid Rust driver response");
    if ("error" in result) throw new Error(typeof result.error === "string" ? result.error : "Rust driver error");
    if (!("ok" in result)) throw new Error("invalid Rust driver response");
    return result.ok;
  }
  return {
    // These casts follow the Rust serde boundary, not unvalidated network JSON.
    runtime(): unknown { return run({ op: "runtime" }); },
    config(json: string): Config { return run({ op: "config", json }) as Config; },
    start(evidence: unknown): unknown { return run({ op: "start", evidence }); },
    request(session: unknown, provider: Config["provider"], actions: Monitor["actions"], tools: RegisteredTool[] = []): unknown { return run({ op: "request", session, provider, actions, tools }); },
    validateTool(tool: RegisteredTool, args: unknown): boolean {
      const result = run({ op: "validate_tool", tool, args });
      if (result !== true) throw new Error("invalid tool validation response");
      return result;
    },
    accept(session: unknown, kind: Config["provider"]["kind"], response: unknown): Accepted { return run({ op: "accept", session, kind, response }) as Accepted; },
    results(session: unknown, results: unknown[]): unknown { return run({ op: "results", session, results }); },
    telemetry(json: string): Signal[] { return run({ op: "telemetry", json }) as Signal[]; },
    decision(monitor: Monitor, call: Call, approved: string | null, attempted: boolean): string {
      const result = run({ op: "decision", monitor, call, approved, attempted });
      if (typeof result !== "string") throw new Error("invalid decision");
      return result;
    },
    redact(text: string): string {
      const result = run({ op: "redact", text });
      if (typeof result !== "string") throw new Error("invalid redaction");
      return result;
    },
  };
}
