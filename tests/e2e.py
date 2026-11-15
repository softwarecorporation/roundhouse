"""Real binary + HTTP test app + scripted SSE provider. No third-party Python packages.

The fixture exercises Rotary's actual provider/agent/tool path, not model intelligence.
Use examples/live_demo.py to exercise an authenticated real model instead.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def http(url, method="GET", body=None, token=None, key=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if key:
        headers["Idempotency-Key"] = key
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(url, data=data, headers=headers, method=method), timeout=3) as r:
            payload = r.read()
            return r.status, json.loads(payload) if payload else None
    except HTTPError as e:
        return e.code, None


class TestApplication:
    def __init__(self):
        self.worker = None
        self.worker_stop = threading.Event()
        self.jobs_completed = 0
        self.action_count = 0
        self.provider_count = 0
        self.noop = False
        self.repeat = False
        self.unknown_action = False
        self.reject_action = False
        self.hang_provider = False
        self.hang_action = False
        self.provider_failure = False
        self.provider_inputs = []
        self.idempotency_keys = []
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, code, data):
                payload = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path == "/health":
                    self.reply(200 if app.healthy else 503, {"healthy": app.healthy})
                elif self.path == "/diagnostics":
                    self.reply(200, {"cause": "worker is running" if app.healthy else "worker is stopped",
                                     "jobs_completed": app.jobs_completed, "remedy": "restart_worker",
                                     "sensitive": "demo-recovery-secret-not-for-model"})
                else:
                    self.reply(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if self.path == "/recover":
                    if self.headers.get("Authorization") != "Bearer demo-recovery-secret-not-for-model":
                        self.reply(401, {})
                        return
                    app.action_count += 1
                    app.idempotency_keys.append(self.headers.get("Idempotency-Key"))
                    if app.hang_action:
                        time.sleep(10)
                        return
                    if app.reject_action:
                        self.reply(500, {"error": "failed"})
                        return
                    if not app.noop:
                        app.healthy = True
                    self.reply(200, {"accepted": True})
                elif self.path == "/v1/chat/completions":
                    app.provider_count += 1
                    app.provider_inputs.append(json.dumps(body))
                    if app.provider_failure:
                        self.reply(401, {"error": "unauthorized demo-provider-key"})
                        return
                    if app.hang_provider:
                        time.sleep(10)
                    tool_messages = [m for m in body["messages"] if m["role"] == "tool"]
                    can_request_recovery = any(t["function"]["name"] == "request_recovery" for t in body["tools"])
                    if not tool_messages:
                        delta = {"tool_calls": [{"index": 0, "id": "inspect-call", "type": "function",
                                 "function": {"name": "inspect_system", "arguments": "{}"}}]}
                    elif can_request_recovery and (len(tool_messages) == 1 or app.repeat):
                        action = "unconfigured_action" if app.unknown_action else "restart_worker"
                        delta = {"tool_calls": [{"index": 0, "id": f"recover-{len(tool_messages)}", "type": "function",
                                 "function": {"name": "request_recovery", "arguments": json.dumps({"action": action})}}]}
                    else:
                        delta = {"content": "The stopped worker explains the failed health check. Recovery requested; host must verify health."}
                    finish = "tool_calls" if "tool_calls" in delta else "stop"
                    payload = ("data: " + json.dumps({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
                               + "\n\ndata: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    try:
                        self.wfile.write(payload)
                    except BrokenPipeError:
                        pass
                else:
                    self.reply(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    @property
    def healthy(self):
        return self.worker is not None and self.worker.is_alive() and not self.worker_stop.is_set()

    @healthy.setter
    def healthy(self, running):
        if not running:
            self.worker_stop.set()
            if self.worker:
                self.worker.join(timeout=1)
            return
        if self.healthy:
            return
        self.worker_stop = threading.Event()
        stop = self.worker_stop

        def work():
            # The test application has a real worker. Recovery starts this loop;
            # health observes thread liveness rather than a preset HTTP response.
            while not stop.is_set():
                self.jobs_completed += 1
                stop.wait(0.05)

        self.worker = threading.Thread(target=work, daemon=True)
        self.worker.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.healthy = False


class Harness:
    def __init__(self, app, production=False, **limits):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.app = app
        self.process = None
        self.log = None
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.config = {
            "listen": f"127.0.0.1:{port}", "database": str(self.path / "roundhouse.sqlite"),
            "api_token_env": "RH_TEST_API_TOKEN", "event_token_env": "RH_TEST_EVENT_TOKEN",
            "provider": {"kind": "openai_compatible", "base_url": app.url + "/v1",
                         "model": "fixture", "api_key_env": "RH_TEST_PROVIDER_KEY"},
            "limits": {"daily_budget_microusd": 100000, "reserve_per_request_microusd": 1000,
                       "daily_requests": 20, "requests_per_incident": 8, "daily_actions": 5,
                       "investigation_timeout_seconds": 8, **limits},
            "monitors": [{"id": "test-app", "health_url": app.url + "/health", "expected_status": 200,
                          "interval_seconds": 1, "timeout_seconds": 2, "verification_attempts": 2,
                          "verification_interval_seconds": 1, "environment": "production" if production else "test",
                          "diagnostics": [{"name": "worker", "url": app.url + "/diagnostics", "token_env": "RH_TEST_RECOVERY_TOKEN"}],
                          "actions": [{"name": "restart_worker", "description": "Restart the stopped worker",
                                       "url": app.url + "/recover", "token_env": "RH_TEST_RECOVERY_TOKEN",
                                       "auto_approve": not production}]}],
        }

    def start(self):
        (self.path / "config.json").write_text(json.dumps(self.config))
        env = {**os.environ, "RH_TEST_API_TOKEN": "demo-api-token", "RH_TEST_EVENT_TOKEN": "demo-event-token", "RH_TEST_PROVIDER_KEY": "demo-provider-key",
               "RH_TEST_RECOVERY_TOKEN": "demo-recovery-secret-not-for-model"}
        self.log = open(self.path / "service.log", "ab")
        binary = os.environ.get("ROUNDHOUSE_TEST_BINARY", str(ROOT / "target/debug/roundhouse"))
        self.process = subprocess.Popen([binary, str(self.path / "config.json")],
                                        cwd=ROOT, env=env, stdout=self.log, stderr=self.log)
        for _ in range(100):
            if self.process.poll() is not None:
                raise AssertionError("service exited: " + (self.path / "service.log").read_text())
            try:
                if http(self.url + "/healthz")[0] == 200:
                    return
            except (OSError, TimeoutError):
                pass
            time.sleep(0.05)
        raise AssertionError("service did not start")

    def request(self, path, method="GET", body=None, key=None):
        token = "demo-event-token" if path == "/v1/events" else "demo-api-token"
        return http(self.url + path, method, body, token, key)

    def wait_state(self, state, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, payload = self.request("/v1/incidents")
            if status == 200:
                for incident in payload["incidents"]:
                    if incident["state"] == state:
                        return incident
            time.sleep(0.1)
        raise AssertionError(f"did not reach {state}: {self.request('/v1/incidents')}")

    def stop(self, kill=False):
        if self.process and self.process.poll() is None:
            self.process.kill() if kill else self.process.terminate()
            self.process.wait(timeout=5)
        if self.log:
            self.log.close()

    def close(self):
        self.stop()
        self.temp.cleanup()


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.app = TestApplication()
        self.h = None

    def tearDown(self):
        if self.h:
            self.h.close()
        self.app.close()

    def start(self, **kwargs):
        self.h = Harness(self.app, **kwargs)
        self.h.start()

    def test_scheduled_detection_rotary_investigation_and_verified_recovery(self):
        self.start()
        incident = self.h.wait_state("resolved")
        history = self.h.request("/v1/incidents/" + incident["id"])[1]["history"]
        kinds = [e["kind"] for e in history]
        for kind in ["detected", "inspection", "provider_request_reserved", "investigation", "action_claimed", "action_outcome", "verification"]:
            self.assertIn(kind, kinds)
        self.assertTrue(self.app.healthy)
        self.assertEqual(self.app.action_count, 1)
        self.assertEqual(self.app.idempotency_keys, [incident["id"] + ":restart_worker"])
        self.assertGreaterEqual(self.app.provider_count, 3)
        self.assertNotIn("demo-recovery-secret-not-for-model", json.dumps(history))
        self.assertNotIn("demo-recovery-secret-not-for-model", "".join(self.app.provider_inputs))
        self.h.stop()
        self.assertNotIn("demo-provider-key", (self.h.path / "service.log").read_text())
        self.h.start()
        self.assertEqual(self.h.wait_state("resolved")["id"], incident["id"])
        self.assertEqual(self.app.action_count, 1)

    def test_production_requires_exact_single_use_approval(self):
        self.start(production=True)
        incident = self.h.wait_state("awaiting_approval")
        path = f"/v1/incidents/{incident['id']}/approve"
        self.assertEqual(self.app.action_count, 0)
        self.assertEqual(self.h.request(path, "POST", {"action": "wrong"})[0], 409)
        self.assertEqual(http(self.h.url + path, "POST", {"action": "restart_worker"})[0], 401)
        self.assertEqual(http(self.h.url + path, "POST", {"action": "restart_worker"}, "demo-event-token")[0], 401)
        self.assertEqual(self.h.request(path, "POST", {"action": "restart_worker"})[0], 200)
        self.h.wait_state("resolved")
        self.assertEqual(self.h.request(path, "POST", {"action": "restart_worker"})[0], 409)
        self.assertEqual(self.app.action_count, 1)

    def test_successful_action_does_not_imply_recovery(self):
        self.app.noop = True
        self.start()
        self.h.wait_state("needs_attention")
        self.assertFalse(self.app.healthy)
        self.assertEqual(self.app.action_count, 1)

    def test_budget_prevents_provider_request_and_action(self):
        self.start(daily_budget_microusd=1000)
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.provider_count, 1)
        self.assertEqual(self.app.action_count, 0)
        self.h.stop()
        self.h.start()
        time.sleep(1)
        self.assertEqual(self.app.provider_count, 1)

    def test_daily_action_limit_blocks_changes(self):
        self.start(daily_actions=0)
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.action_count, 0)

    def test_unknown_action_is_not_executed(self):
        self.app.unknown_action = True
        self.start()
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.action_count, 0)

    def test_repeated_tool_calls_do_not_replay_action(self):
        self.app.noop = True
        self.app.repeat = True
        self.start(requests_per_incident=4)
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.action_count, 1)
        self.assertLessEqual(self.app.provider_count, 4)

    def test_event_authentication_deduplication_and_validation(self):
        self.app.healthy = True
        self.start()
        self.assertEqual(http(self.h.url + "/v1/incidents")[0], 401)
        self.assertEqual(self.h.request("/v1/events", "POST", {"monitor": "test-app"})[0], 400)
        self.assertEqual(self.h.request("/v1/events", "POST", {"monitor": "missing"}, "a")[0], 404)
        first = self.h.request("/v1/events", "POST", {"monitor": "test-app"}, "event-1")
        second = self.h.request("/v1/events", "POST", {"monitor": "test-app"}, "event-1")
        self.assertEqual(first, second)
        self.h.wait_state("resolved")
        self.h.stop()
        self.h.start()
        self.assertEqual(self.h.request("/v1/events", "POST", {"monitor": "test-app"}, "event-1"), first)
        self.assertEqual(self.app.provider_count, 0)

    def test_interrupted_investigation_is_not_replayed_on_restart(self):
        self.app.hang_provider = True
        self.start()
        self.h.wait_state("investigating")
        deadline = time.monotonic() + 3
        while self.app.provider_count < 1 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.h.stop(kill=True)
        self.h.start()
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.provider_count, 1)
        self.assertEqual(self.app.action_count, 0)

    def test_rejected_action_remains_unresolved(self):
        self.app.reject_action = True
        self.start()
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.action_count, 1)
        self.assertFalse(self.app.healthy)

    def test_external_recovery_closes_incident_without_another_action(self):
        self.app.noop = True
        self.start()
        incident = self.h.wait_state("needs_attention")
        self.app.healthy = True
        self.assertEqual(self.h.wait_state("resolved")["id"], incident["id"])
        self.assertEqual(self.app.action_count, 1)
        history = self.h.request("/v1/incidents/" + incident["id"])[1]["history"]
        self.assertIn("external_recovery_verified", [e["kind"] for e in history])

    def test_uncertain_action_is_not_replayed_after_process_death(self):
        self.app.hang_action = True
        self.start()
        deadline = time.monotonic() + 5
        while not self.app.action_count and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.app.action_count, 1)
        self.h.stop(kill=True)
        self.h.start()
        self.h.wait_state("needs_attention")
        time.sleep(1)
        self.assertEqual(self.app.action_count, 1)

    def test_provider_failure_preserves_incident_without_leaking_error_body(self):
        self.app.provider_failure = True
        self.start()
        incident = self.h.wait_state("needs_attention")
        history = self.h.request("/v1/incidents/" + incident["id"])[1]
        self.assertEqual(self.app.action_count, 0)
        self.assertNotIn("demo-provider-key", json.dumps(history))
        self.h.stop()
        self.assertNotIn("demo-provider-key", (self.h.path / "service.log").read_text())

    def test_configuration_rejects_production_auto_approval(self):
        self.h = Harness(self.app, production=True)
        self.h.config["monitors"][0]["actions"][0]["auto_approve"] = True
        with self.assertRaisesRegex(AssertionError, "service exited"):
            self.h.start()
        self.assertEqual(self.app.action_count, 0)

    def test_misplaced_secret_is_not_echoed_in_startup_error(self):
        self.h = Harness(self.app)
        misplaced = "accidentally-pasted-provider-secret-value"
        self.h.config["provider"]["api_key_env"] = misplaced
        with self.assertRaisesRegex(AssertionError, "service exited"):
            self.h.start()
        self.assertNotIn(misplaced, (self.h.path / "service.log").read_text())

    def test_provider_deadline_stops_investigation(self):
        self.app.hang_provider = True
        self.start(investigation_timeout_seconds=1)
        self.h.wait_state("needs_attention", timeout=5)
        self.assertEqual(self.app.provider_count, 1)
        self.assertEqual(self.app.action_count, 0)

    def test_read_only_monitor_does_not_expose_recovery_to_model(self):
        self.h = Harness(self.app)
        self.h.config["monitors"][0]["actions"] = []
        self.h.start()
        self.h.wait_state("needs_attention")
        self.assertEqual(self.app.provider_count, 2)
        self.assertEqual(self.app.action_count, 0)
        for request in self.app.provider_inputs:
            names = [t["function"]["name"] for t in json.loads(request)["tools"]]
            self.assertEqual(names, ["inspect_system"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
