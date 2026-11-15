#!/usr/bin/env python3
"""Verify an isolated deployed loop, including real job results and exact approval.

Uses only the generated disposable application's authority. By default stops
monitoring after verification; --leave-running leaves healthy scheduled probes on.
"""
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

def main():
    c = json.loads((ROOT / ".roundhouse-test-secrets.json").read_text())
    def call(base, path, token=None, body=None, expected=200, extra=None):
        headers = {"Content-Type": "application/json", "User-Agent": "Roundhouse-Test/0.2", **(extra or {})}
        if token: headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, json.dumps(body).encode() if body is not None else None, headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r: status, data = r.status, r.read()
        except urllib.error.HTTPError as e: status, data = e.code, e.read()
        assert status == expected, f"{path}: expected {expected}, got {status}: {data[:300]!r}"
        return json.loads(data) if data else None
    def edge(path, body=None, expected=200, token=None, extra=None):
        return call(c["url"], path, c["operator"] if token is None else token, body, expected, extra)
    def app(instance, path, body=None, expected=200):
        return call(c["app_url"], f"/{instance}{path}", c["application"], body, expected)
    def wait_for(fn, message, seconds=150):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = fn()
            if value: return value
            time.sleep(1)
        raise AssertionError(message)
    evidence = {"url": c["url"], "app_url": c["app_url"], "version": c["version"], "app_version": c["app_version"], "fixture": c["fixture"], "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    edge("/v1/stop", {})
    for instance in ("auto", "approval"):
        fault = app(instance, "/fault", {})
        assert not fault["healthy"] and fault["recoveries"] == 0 and len(fault["jobs"]) == 3
        app(instance, "/health", expected=503)
    edge("/v1/incidents", expected=401, token=c["event"])
    now = int(time.time() * 1000)
    base = {"service": "auto", "timestamp": now, "properties": {"environment": "test"}}
    trace = "a" * 32
    signals = [dict(base, id="demo-event", kind="event", name="job.queued", distinct_id="worker"),
        dict(base, id="demo-log", kind="log", name="worker.stopped", level="error", message="worker is stopped", trace_id=trace),
        dict(base, id="demo-span", kind="span", name="job.process", trace_id=trace, span_id="b" * 16, duration_ms=37, status="error"),
        dict(base, id="demo-gauge", kind="metric", name="queue.depth", metric_type="gauge", value=3, unit="jobs")]
    capture = edge("/v1/telemetry", signals, token=c["event"])
    assert capture == {"accepted": 4, "duplicates": 0}, capture
    assert edge("/v1/telemetry", signals, token=c["event"])["duplicates"] == 4
    trace_records = edge(f"/v1/telemetry?service=auto&trace_id={trace}&until={now+1}")
    assert {r["kind"] for r in trace_records["records"]} == {"log", "span"}
    counts = edge(f"/v1/analytics?service=auto&kind=event&name=job.queued&until={now+1}")
    assert sum(b["count"] for b in counts["buckets"]) == 1
    evidence["telemetry"] = {"capture": capture, "trace_records": trace_records, "event_counts": counts}
    # No event enqueue: the deployed Durable Object alarm must detect the faults.
    edge("/v1/start", {})
    try:
        def incidents(): return edge("/v1/incidents")["incidents"]
        def find(name, state): return next((i for i in incidents() if i["monitor"] == name and i["state"] == state), None)
        auto = wait_for(lambda: find("auto", "resolved"), "automatic recovery did not resolve")
        pending = wait_for(lambda: find("approval", "awaiting_approval"), "production proposal not gated")
        assert app("approval", "/status")["recoveries"] == 0
        edge(f'/v1/incidents/{pending["id"]}/approve', {"action": "wrong_action"}, expected=409)
        edge(f'/v1/incidents/{pending["id"]}/approve', {"action": "restart_worker"}, expected=401, token=c["event"])
        edge(f'/v1/incidents/{pending["id"]}/approve', {"action": "restart_worker"})
        edge(f'/v1/incidents/{pending["id"]}/approve', {"action": "restart_worker"}, expected=409)
        approved = wait_for(lambda: find("approval", "resolved"), "approved recovery did not resolve")
        evidence["incidents"] = []
        for instance, incident in (("auto", auto), ("approval", approved)):
            state = app(instance, "/status")
            assert state["healthy"] and state["recoveries"] == 1
            for job in state["jobs"]:
                assert job["result"] == hashlib.sha256(job["payload"].encode()).hexdigest()
            history = edge(f'/v1/incidents/{incident["id"]}')["history"]
            assert sum(h["kind"] == "action_claimed" for h in history) == 1
            assert any(h["kind"] == "investigation" for h in history)
            assert any(h["kind"] == "verification" and json.loads(h["detail"])["healthy"] for h in history)
            probes = edge(f"/v1/probes?service={instance}")
            assert any(not p["healthy"] and p["status"] == 503 for p in probes["observations"])
            evidence["incidents"].append({"monitor": instance, "incident": incident, "application": state, "history": history, "probes": probes})
        evidence["budgets"] = edge("/v1/status")["budgets"]
        assert sum(b["actions"] for b in evidence["budgets"]) == 2
        if "--leave-running" not in sys.argv: edge("/v1/stop", {})
        evidence["monitoring_enabled"] = edge("/v1/status")["enabled"]
        print(json.dumps(evidence, indent=2))
    except Exception:
        edge("/v1/stop", {})
        print(json.dumps({"incidents": edge("/v1/incidents"), "status": edge("/v1/status")}), file=sys.stderr)
        raise

if __name__ == "__main__": main()
