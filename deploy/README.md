# Run the native fixed-action host without a laptop

Choose an always-on Linux server with persistent local storage and network access to your model and application endpoints. Do not treat an interactive development orb as production hosting.

This page deploys the native Rust `roundhouse` host with configured HTTP diagnostics and named recovery actions. Its `roundhouse.service` and Compose hardening are for that host, not for arbitrary Bash execution. It does not launch the independent Python executor or the npm Worker controller.

For the sandboxed Bash service, follow [the executor's always-on Linux setup](../executor/README.md#install-on-an-always-on-linux-host). Reviewable executor units and an agent-only TLS proxy example are in [`deploy/executor`](executor/). Do not reuse this page's service unit for Bubblewrap.

## Prepare the release

1. Build and run the checks in the root README. Keep the previous binary or container image for rollback.
2. Create a system account named `roundhouse` and `/etc/roundhouse`. Restrict the directory to the operator and service account.
3. Install your configuration as `/etc/roundhouse/config.json`. For systemd, keep `listen` at `127.0.0.1:8080`. For Compose, use `0.0.0.0:8080` **inside the container**; Compose publishes only host loopback.
4. Set `database` to `/var/lib/roundhouse/roundhouse.sqlite`.
5. Provision the required environment variables in `/etc/roundhouse/secrets.env` through your secret manager. Use environment-file syntax (`NAME=value`, no `export`) and file mode 0600. Never put this file in Git or a Docker build context.
6. Configure a dedicated provider key with a provider-side spending cap. Give recovery tokens only the named endpoint's authority. Start with a staging application and `auto_approve: false`.

The example uses `ROUNDHOUSE_OPERATOR_TOKEN`, `ROUNDHOUSE_EVENT_TOKEN`, `ROUNDHOUSE_PROVIDER_KEY`, `ROUNDHOUSE_DIAGNOSTIC_TOKEN`, and `ROUNDHOUSE_RECOVERY_TOKEN`. Generate distinct high-entropy operator and event tokens. The service refuses missing or empty configured secrets.

## Run with systemd

Install the release binary as `/usr/local/bin/roundhouse` and `roundhouse.service` as `/etc/systemd/system/roundhouse.service`. Review the concrete application targets and action permissions before starting:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now roundhouse
sudo systemctl status roundhouse
```

Expected startup log: `Roundhouse ready; durable queue and monitoring enabled`. Check `/healthz` over host loopback, then read `/v1/incidents` with the operator token. Configure an external uptime monitor for the Roundhouse API itself.

## Run with Docker Compose

From the repository root, after preparing the configuration and secret file:

```sh
docker compose -f deploy/compose.yaml up --build -d
docker compose -f deploy/compose.yaml ps
```

Compose uses a named volume for SQLite, drops capabilities, runs as a non-root user, and restarts on daemon or host restart. Enable the Docker daemon at boot. Do not mount a Docker socket, host root, SSH key directory, or application filesystem into the container.

## Verify before production

1. Break a disposable staging subsystem and observe a new incident and persisted inspection evidence.
2. Confirm that the recovery endpoint has not received a POST before you approve the pending action.
3. Approve the exact named action through the authenticated API.
4. Confirm the application health endpoint recovers and the incident contains host-generated verification evidence.
5. Restart the Roundhouse process. Confirm that history and budgets remain and the action is not replayed.
6. Test the downstream adapter's failure, timeout, and idempotency behavior. HTTP 2xx without healthy application status must not resolve the incident.

Only enable production after approving the server, provider account limit, exact target endpoints, and action scopes. Production monitors cannot auto-approve actions.

## Stop and roll back

Stop the service with `systemctl stop roundhouse` or `docker compose -f deploy/compose.yaml stop`. Restore the previous binary or pinned image without deleting the volume. Configuration changes require a restart.

Roundhouse marks any interrupted `investigating` incident as `needs_attention` on startup and consumes no new authority for it. Reconcile uncertain downstream action outcomes manually. Never remove a durable action claim just to retry it. The initial release has additive schema creation only; a future schema migration needs a separate reviewed backup and rollback procedure.
