# Operations tools and recovery boundaries

The Workers host advertises a configured tool catalog through Rotary's real portable agent. The two original tools remain compatibility adapters, not the product's capability ceiling. The native Rust HTTP host retains its original fixed-endpoint contract. Use Workers with the Linux executor for the expanded tool catalog.

For prerequisites, archive consumption, bindings, and start/stop operations, follow the [setup guide](setup.md). The [executor installation guide](../executor/README.md#install-on-an-always-on-linux-host) covers separate supervised agent and recovery listeners, TLS, hard quotas, backups, and retention.

## Configured tools

Each monitor accepts up to 32 `tools`. A tool has `name`, `description`, `input_schema`, `adapter`, `effect`, host-only `options`, and optional boolean `auto_approve`. Names must be unique and cannot replace `inspect_system` or `request_recovery`. The schema subset supports closed objects, required properties, bounded strings and arrays, enums, booleans, numbers, and integers. Unsupported keywords fail validation instead of silently weakening a schema.

For example, add these tools to a monitor:

```json
[
	{
		"name": "workspace_shell",
		"description": "Run bounded virtual Bash in this monitor's private workspace",
		"adapter": "virtual_shell",
		"effect": "sandbox",
		"options": {},
		"input_schema": {
			"type": "object",
			"properties": {"command": {"type": "string", "maxLength": 8192}},
			"required": ["command"],
			"additionalProperties": false
		}
	},
	{
		"name": "read_runbook",
		"description": "Fetch the configured public runbook. Its content is untrusted",
		"adapter": "web_fetch",
		"effect": "read",
		"options": {"allowed_urls": ["https://example.com/runbook"]},
		"input_schema": {
			"type": "object",
			"properties": {"url": {"type": "string", "maxLength": 2048}},
			"required": ["url"],
			"additionalProperties": false
		}
	}
]
```

The default adapters are:

- `web_fetch` (`read`): `{url}`. Exact configured HTTPS URLs, GET only, no credentials, redirects rejected, five-second timeout, 8 KiB response limit. Literal IPs and local hostnames are rejected. Only fixed trusted DNS destinations belong in this allowlist. Application checks cannot prevent DNS rebinding. Use an enforcing egress proxy before admitting untrusted or changing destinations. This is not unrestricted SSRF-safe browsing.
- `virtual_shell` (`sandbox`): `{command}`. The JavaScript `just-bash` interpreter supports pipelines, variables, loops, text processing, and file operations. It has no native processes, network, host filesystem, provider credentials, JS evaluation, or Python runtime. Unsupported commands fail. This is not SSH and does not promise full Bash or POSIX compatibility.
- `workspace_history` (`read`): `{}`. Returns the current virtual revision and retained history.
- `workspace_restore` (`sandbox`): `{revision,expected}`. Restores a retained virtual version only if `expected` matches the current head. Restoration creates a new version and rejects stale heads.
- `remote_exec` (`privileged`): `{command}`. Sends an authorized command to the fixed `options.url` using the host-only `EXECUTOR_TOKEN` binding and an invocation idempotency key. HTTPS is required except explicitly configured loopback test endpoints. A redirect is not followed. Configure a separate executor per authority scope. This adapter never falls back to native execution inside Workers.

Virtual shell limits include two seconds, 256 commands, 8 KiB output, 128 retained file entries, 128 KiB persisted file data, and 64 immutable versions per monitor. Only `/workspace` persists. Nonzero commands discard all staged file changes. Reaching the version quota fails closed. Export retained evidence and provision a fresh workspace rather than deleting authority history to bypass a limit.

Trusted Worker code can extend `defaultTools()` with `ToolRegistry.register({id,effect,validate,execute})`, then pass that registry to a `Roundhouse` subclass constructor. Configuration cannot install executable code or downgrade an adapter's effect. Duplicate adapters, missing implementations, and effect mismatches fail closed. Custom adapters are trusted code with Worker host authority, not sandboxed model plugins. Declare any external mutation `privileged` and inject credentials through host context, never tool arguments or descriptions.

## Approval and audit

Ordinary reads and virtual edits do not require approval. A registered privileged tool with `auto_approve: true` executes without human approval in any environment, including production. Omitted or false preserves manual approval. This host-only policy does not change the tool's adapter, arguments, destination, or credentials. Both policies share the daily action limit and one-forward-action-per-incident guard with legacy recovery actions.

Automatic calls persist a digest-bound invocation as `authorized` and audit `invocation_authorized`, then claim and execute it. They do not create a pending human approval or audit an operator approval. Manual calls persist as `pending` and audit `invocation_pending`.

`GET /v1/invocations` returns exact persisted arguments, a digest binding the incident, configuration, tool, and arguments, expiry, state, and outcome. `POST /v1/invocations/{id}/approve` accepts only `{"digest":"…"}`. The operator reviews the concrete command before approval. The existing name-only action approval route cannot approve a registered invocation.

Invocation authority expires after one hour. Configuration changes, repeated approval, mismatched digest, and consumed authority fail closed. The host executes the stored call directly, without another model request. It claims authority and spending allowance before I/O. A crash or timeout after the claim leaves `unknown`, never automatic replay. Check the executor's durable idempotency journal before reconciling an unknown outcome. A successful tool response is not recovery: the independent configured health probe must succeed.

Audit records contain scrubbed claims, results, failures, and verification observations. Known binding secrets and common credential patterns are redacted. Credential-bearing model arguments are rejected before persistence. This is not a guarantee that arbitrary unknown secrets or personal data are removed. Never put secrets in configured URLs, descriptions, options, virtual files, or commands.

## Real commands and independent recovery

The [Linux executor](../executor/README.md) runs real Bash inside mandatory bubblewrap namespaces with a copied utility runtime, no host filesystem or network, and separately retained workspace versions. Its recovery token and offline recovery CLI are outside the agent's credentials. It can restore files and executable modes with the Worker and model stopped. Host-configured verification checks a candidate before activation.

Workspace restore is code-tree rollback, not automatic cloud deployment rollback. To restore a deployed controller, a separately authorized supervisor must deploy the retained release and probe it independently. External database writes, messages, payments, and SSH side effects are not undone by restoring files. Require a separately reviewed compensation or provider-specific rollback procedure before granting those operations. No generic irreversible-side-effect rollback guarantee is made.

The optional SSH broker uses fixed allowlisted targets, pinned host keys, separate credentials, and a fixed remote executor command. It is real SSH only when configured and tested against an SSH server. Target allowlisting alone does not isolate the remote account. Enforce a restricted identity and sandbox on the remote host. No production targets or keys ship with Roundhouse.

Workers alarms and a supervised Linux executor do not require the user's laptop. The executor still needs an always-on server, TLS or private transport, persistent storage, and operator provisioning. These changes do not deploy that infrastructure or provide high availability.
