import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

test("Rotary tools execute real virtual pipelines, bounded fetch and exact durable privileged approval", async () => {
  const fixture = Bun.spawn(["python3", "-u", "-c", `
import sys, tempfile, pathlib, threading, http.server, json, os, shutil
sys.path.insert(0, sys.argv[1])
import executor
root = pathlib.Path(tempfile.mkdtemp(prefix="roundhouse-worker-executor-"))
try:
    source = root / "source"
    source.mkdir()
    (source / "health").write_text("broken")
    executor.initialize(root / "state", source, 'test "$(cat health)" = healthy')
    runtime = executor.Executor(root / "state")
    server = http.server.HTTPServer(("127.0.0.1", 0), executor.handler_for(runtime, "agent"))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({"port":server.server_port,"token":(root / "state/agent.token").read_text(),"state":str(root / "state")}), flush=True)
    sys.stdin.read()
    server.shutdown()
finally:
    for parent, dirs, files in os.walk(root, followlinks=False):
        pathlib.Path(parent).chmod(0o700)
        for name in dirs:
            p = pathlib.Path(parent) / name
            if not p.is_symlink(): p.chmod(0o700)
    shutil.rmtree(root)
`, resolve(import.meta.dir, "../../executor")], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const first = await fixture.stdout.getReader().read();
  const native = JSON.parse(new TextDecoder().decode(first.value));
  const stringSchema = (key: string) => ({ type: "object", properties: { [key]: { type: "string", maxLength: 8192 } }, required: [key], additionalProperties: false });
  const tools = [
    { name: "fetch_manual", adapter: "web_fetch", effect: "read", description: "Read manual", input_schema: stringSchema("url"), options: { allowed_urls: ["https://manual.test/runbook", "https://manual.test/redirect"] } },
    { name: "shell", adapter: "virtual_shell", effect: "sandbox", description: "Virtual shell", input_schema: stringSchema("command"), options: {} },
    { name: "restore", adapter: "workspace_restore", effect: "sandbox", description: "Restore virtual files", input_schema: { type: "object", properties: { revision: { type: "integer", minimum: 1 }, expected: { type: "integer", minimum: 0 } }, required: ["revision", "expected"], additionalProperties: false }, options: {} },
    { name: "execute", adapter: "remote_exec", effect: "privileged", description: "Approved isolated executor", input_schema: stringSchema("command"), options: { url: "https://executor.test/execute" } },
  ];
  const calls = [
    ["fetch_manual", { url: "https://evil.test/" }],
    ["fetch_manual", { url: "https://manual.test/redirect" }],
    ["fetch_manual", { url: "https://manual.test/runbook" }],
    ["shell", { command: "printf 'healthy\\n' > app; cat app | tr a-z A-Z" }],
    ["shell", { command: "echo bad > app; false" }],
    ["shell", { command: "echo broken > app" }],
    ["restore", { revision: 1, expected: 2 }],
    ["shell", { command: "cat app; curl https://evil.test" }],
    ["shell", { command: "cat app; env" }],
    ["execute", { command: "printf healthy > health; cat health" }],
  ];
  let step = 0, executions = 0;
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push(url.pathname);
    if (url.pathname === "/health") return new Response("health", { status: await Bun.file(native.state + "/current/health").text() === "healthy" ? 200 : 503 });
    if (url.pathname === "/runbook") { expect(request.headers.has("authorization")).toBe(false); return new Response("check app file"); }
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
    if (url.pathname === "/execute") {
      executions++; expect(request.headers.get("authorization")).toBe("Bearer " + native.token);
      return fetch(`http://127.0.0.1:${native.port}/execute`, request);
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await request.json();
      expect(body.tools.map(t => t.function.name)).toContain("shell");
      expect(JSON.stringify(body)).not.toContain(native.token);
      const call = calls[step++];
      if (!call) throw new Error("approved invocation unexpectedly reconstructed by model");
      return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${step}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }] });
    }
    return new Response("unexpected", { status: 500 });
  } });
  const root = resolve(import.meta.dir, "..");
  const config = { provider: { kind: "openai_compatible", base_url: "https://model.test/v1", model: "fixture", max_output_tokens: 256 }, limits: { daily_budget_microusd: 1000, reserve_per_request_microusd: 1, daily_requests: 30, requests_per_incident: 12, daily_actions: 1, investigation_timeout_seconds: 20 }, monitors: [{ id: "app", health_url: "https://app.test/health", expected_status: 200, interval_seconds: 300, timeout_seconds: 2, environment: "production", diagnostics: [], actions: [], tools }] };
  const mf = new Miniflare({ name: "operations", compatibilityDate: "2026-08-06", modulesRoot: root,
    modules: [{ type: "ESModule", path: resolve(root, "dist/workers.js") }, { type: "CompiledWasm", path: resolve(root, "wasm/roundhouse_core_bg.wasm") }],
    durableObjects: { ROUNDHOUSE: { className: "Roundhouse", useSQLite: true } },
    bindings: { ROUNDHOUSE_CONFIG: JSON.stringify(config), OPERATOR_TOKEN: "operator-fixture", EVENT_TOKEN: "event-fixture", PROVIDER_API_KEY: "model-fixture", EXECUTOR_TOKEN: native.token },
    outboundService: request => {
      expect(["model.test", "app.test", "manual.test", "executor.test"]).toContain(new URL(request.url).host);
      return fetch(new URL(new URL(request.url).pathname, server.url), request);
    },
  });
  async function api(path: string, body?: unknown, status = 200) {
    const response = await mf.dispatchFetch("https://controller.test" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer operator-fixture", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); expect({ status: response.status, ...(response.status !== status ? { value } : {}) }).toEqual({ status }); return value;
  }
  async function wait(state: string) {
    for (let n = 0; n < 160; n++) {
      const list = await api("/v1/incidents");
      if (list.incidents[0]?.state === state) return list.incidents[0];
      await Bun.sleep(100);
    }
    throw new Error(`state ${state} not reached: ${JSON.stringify(await api("/v1/incidents"))}`);
  }
  try {
    await api("/v1/start", {});
    const incident = await wait("awaiting_approval");
    expect(executions).toBe(0);
    const history = await api(`/v1/incidents/${incident.id}`);
    const results = history.history.filter(h => h.kind === "tool_result").map(h => JSON.parse(h.detail).value);
    expect(results.find(r => r.body === "check app file")).toBeDefined();
    expect(results.find(r => r.stdout === "HEALTHY\n").revision).toBe(1);
    expect(results.find(r => r.exit_code === 1).committed).toBe(false);
    expect(results.find(r => r.restored_from === 1).revision).toBe(3);
    expect(results.at(-1).stdout.startsWith("healthy\n")).toBe(true);
    expect(results.at(-1).stdout).not.toContain("fixture");
    expect(seen).not.toContain("/");
    await api("/v1/stop", {});
    await mf.unsafeEvictDurableObject("operations", "Roundhouse", { name: "controller" });
    const pending = (await api("/v1/invocations"))[0];
    await api(`/v1/invocations/${pending.id}/approve`, { digest: "changed" }, 409);
    await api(`/v1/invocations/${pending.id}/approve`, { digest: pending.digest });
    await api(`/v1/invocations/${pending.id}/approve`, { digest: pending.digest }, 409);
    await api("/v1/start", {});
    await wait("resolved");
    expect(executions).toBe(1); expect(step).toBe(10);
    expect((await api("/v1/invocations"))[0].state).toBe("completed");
    expect(await Bun.file(native.state + "/current/health").text()).toBe("healthy");
    const result = JSON.parse((await api("/v1/invocations"))[0].result);
    expect(result.status).toBe("ok"); expect(result.output).toBe("healthy");
    expect(result.verification.exit_code).toBe(0);
  } finally { await mf.dispose(); server.stop(true); fixture.stdin.end(); await fixture.exited; }
}, 40000);
