"""Use a real model to recover an isolated local HTTP application.

Requires ROUNDHOUSE_DEMO_BASE_URL, ROUNDHOUSE_DEMO_MODEL, and
ROUNDHOUSE_DEMO_KEY_ENV (the name of an already-set API key variable).
Only the disposable test application's restart endpoint is authorized.
"""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from e2e import Harness, TestApplication, http  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-approval", action="store_true",
                        help="Test production policy on the isolated app, then submit one operator approval")
    args = parser.parse_args()
    app = TestApplication()
    h = Harness(app, production=args.require_approval, investigation_timeout_seconds=120)
    try:
        h.config["provider"] = {
            "kind": os.environ.get("ROUNDHOUSE_DEMO_KIND", "openai_compatible"),
            "base_url": os.environ["ROUNDHOUSE_DEMO_BASE_URL"],
            "model": os.environ["ROUNDHOUSE_DEMO_MODEL"],
            "api_key_env": os.environ["ROUNDHOUSE_DEMO_KEY_ENV"],
        }
        initial_health = http(app.url + "/health")[0]
        assert initial_health == 503, "test app did not start broken"
        h.start()
        if args.require_approval:
            pending = h.wait_state("awaiting_approval", timeout=150)
            assert app.action_count == 0, "action ran before operator approval"
            status, _ = h.request(f"/v1/incidents/{pending['id']}/approve", "POST", {"action": "restart_worker"})
            assert status == 200, "operator approval failed"
        incident = h.wait_state("resolved", timeout=150)
        history = h.request("/v1/incidents/" + incident["id"])[1]["history"]
        final_health = http(app.url + "/health")[0]
        assert final_health == 200, "test app is still broken"
        assert app.healthy and app.action_count == 1, "model did not recover the application exactly once"
        assert app.jobs_completed > 0, "the recovered worker did not process any jobs"
        assert app.provider_count == 0, "live demo unexpectedly used fixture provider"
        assert any(e["kind"] == "investigation" for e in history), "no persisted model investigation"
        assert any(e["kind"] == "action_claimed" for e in history), "no persisted action"
        assert any(e["kind"] == "verification" and e["detail"]["evidence"]["healthy"] for e in history), "no independent verification"
        print(json.dumps({"result": "PASS", "provider_model": h.config["provider"]["model"],
                          "initial_health": initial_health, "final_health": final_health,
                          "required_operator_approval": args.require_approval,
                          "worker_jobs_completed": app.jobs_completed,
                          "recovery_requests": app.action_count, "incident": incident,
                          "history": history}, indent=2))
    finally:
        h.close()
        app.close()


if __name__ == "__main__":
    main()
