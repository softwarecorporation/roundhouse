#!/usr/bin/env python3
"""Deploy only uniquely named disposable Roundhouse test Workers using scoped credentials.

No API credential or provider key is printed or persisted. Generated test tokens are
saved mode 0600 to a Git-ignored local file for verification and later stopping.
"""
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID_UNDIVISIBLE"]
API = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT

def api(path, method="GET", data=None, content_type="application/json"):
    headers = {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}
    if data is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(API + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        if not result.get("success"):
            raise RuntimeError("Cloudflare API rejected request")
        return result["result"]
    except urllib.error.HTTPError as e:
        # Cloudflare errors can include supplied bindings, so never echo raw bodies.
        raise RuntimeError(f"Cloudflare API HTTP {e.code} at {path}") from None

def upload(name, modules, bindings, classes):
    if not name.startswith("roundhouse-test-"):
        raise RuntimeError("refusing non-test Worker name")
    existing = api("/workers/scripts")
    if any(x["id"] == name for x in existing):
        raise RuntimeError("refusing to overwrite an existing Worker")
    metadata = {"main_module": "worker.js", "compatibility_date": "2026-11-15", "bindings": bindings,
                "migrations": {"new_tag": "v1", "new_sqlite_classes": classes},
                "observability": {"enabled": True, "traces": {"enabled": True}}}
    boundary = "roundhouse-" + secrets.token_hex(16)
    parts = []
    for filename, content, mime in [("metadata", json.dumps(metadata).encode(), "application/json"), *modules]:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{filename}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    result = api("/workers/scripts/" + name, "PUT", b"".join(parts), "multipart/form-data; boundary=" + boundary)
    api("/workers/scripts/" + name + "/subdomain", "POST", json.dumps({"enabled": True, "previews_enabled": False}).encode())
    deployments = api("/workers/scripts/" + name + "/deployments")["deployments"]
    version = deployments[0]["versions"][0]
    if version["percentage"] != 100:
        raise RuntimeError("test version was not fully deployed")
    return version["version_id"]

def ready(url, field, token=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        headers = {"User-Agent": "Roundhouse-Test/0.2"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                value = json.load(response)
        except urllib.error.HTTPError as e:
            try: value = json.load(e)
            except (ValueError, OSError): value = {}
        except (OSError, ValueError): value = {}
        if field in value: return
        time.sleep(0.5)
    raise RuntimeError("test endpoint did not become ready: " + url)

def main():
    fixture = "--fixture" in sys.argv
    suffix = str(int(time.time())) + "-" + secrets.token_hex(2)
    app_name, worker_name = "roundhouse-test-app-" + suffix, "roundhouse-test-edge-" + suffix
    domain = api("/workers/subdomain")["subdomain"]
    app_url, worker_url = f"https://{app_name}.{domain}.workers.dev", f"https://{worker_name}.{domain}.workers.dev"
    op, event, application = (secrets.token_urlsafe(32) for _ in range(3))
    provider = "roundhouse-fixture" if fixture else os.environ["ANTHROPIC_API_KEY"]
    def secret(name, text): return {"name": name, "type": "secret_text", "text": text}
    app_version = upload(app_name, [("worker.js", (ROOT / "examples/worker-test/app.js").read_bytes(), "application/javascript+module")],
        [{"name": "APP", "type": "durable_object_namespace", "class_name": "TestApplication"}, secret("APP_TOKEN", application), secret("FIXTURE_TOKEN", provider if fixture else "fixture-disabled")], ["TestApplication"])
    monitors = []
    for name in ("auto", "approval"):
        monitors.append({"id": name, "health_url": app_url + f"/{name}/health", "expected_status": 200, "interval_seconds": 5, "timeout_seconds": 5,
            "environment": "test" if name == "auto" else "production", "diagnostics": [{"name": "worker_status", "url": app_url + f"/{name}/status"}],
            "actions": [{"name": "restart_worker", "description": "Restart the stopped job worker so it processes pending SHA-256 jobs", "url": app_url + f"/{name}/recover", "auto_approve": name == "auto"}]})
    config = {"provider": {"kind": "openai_compatible" if fixture else "anthropic", "base_url": app_url + "/auto/v1" if fixture else "https://api.anthropic.com/v1", "model": "fixture" if fixture else "claude-haiku-5-5", "max_output_tokens": 1024},
        "limits": {"daily_budget_microusd": 2000000, "reserve_per_request_microusd": 100000, "daily_requests": 12, "requests_per_incident": 4, "daily_actions": 2, "investigation_timeout_seconds": 90}, "monitors": monitors}
    modules = [("worker.js", (ROOT / "npm/dist/workers.js").read_bytes(), "application/javascript+module"), ("wasm/roundhouse_core_bg.wasm", (ROOT / "npm/wasm/roundhouse_core_bg.wasm").read_bytes(), "application/wasm")]
    # The bundle imports ../wasm relative to dist/workers.js; retain that module layout.
    modules[0] = ("dist/workers.js", modules[0][1], modules[0][2])
    # Cloudflare's main_module is fixed by upload; a tiny public entry exports the packaged host.
    modules.insert(0, ("worker.js", b'export {default,Roundhouse} from "./dist/workers.js";', "application/javascript+module"))
    version = upload(worker_name, modules, [{"name": "ROUNDHOUSE", "type": "durable_object_namespace", "class_name": "Roundhouse"},
        {"name": "ROUNDHOUSE_CONFIG", "type": "plain_text", "text": json.dumps(config)}, secret("OPERATOR_TOKEN", op), secret("EVENT_TOKEN", event), secret("PROVIDER_API_KEY", provider), secret("APPLICATION_TOKEN", application)], ["Roundhouse"])
    record = {"worker": worker_name, "app": app_name, "url": worker_url, "app_url": app_url, "version": version, "app_version": app_version, "operator": op, "event": event, "application": application, "fixture": fixture}
    path = ROOT / ".roundhouse-test-secrets.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file: json.dump(record, file)
    ready(worker_url + "/healthz", "runtime")
    ready(worker_url + "/v1/status", "enabled", op)
    ready(app_url + "/auto/health", "healthy")
    print(json.dumps({k:v for k,v in record.items() if k not in ("operator", "event", "application")}, indent=2))

if __name__ == "__main__": main()
