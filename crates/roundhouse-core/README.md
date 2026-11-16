# Portable Roundhouse Rust core

`roundhouse-core` is an `rlib` and `cdylib` containing Roundhouse configuration, action authority and telemetry validation, plus a thin bridge to Rotary's public `rx4::lite::Agent` and shared permissions/redaction. It compiles for native Rust and `wasm32-unknown-unknown`. It does not schedule work, call networks, store secrets, or persist incidents by itself.

The native server uses Rotary's native Agent. The Workers host compiles Rotary with only its `lite` feature, excluding native runtime/filesystem dependencies. See [UPSTREAM.md](UPSTREAM.md) for provenance and the eqts example that informed the direct Wasm bridge.

## Consume from Rust

Until a registry release is explicitly authorized, depend on a local checkout:

```toml
[dependencies]
roundhouse-core = { path = "../roundhouse/crates/roundhouse-core" }
serde_json = "1"
```

The synchronous JSON bridge exposes the same contract used by JavaScript:

```rust
use roundhouse_core::dispatch;
use serde_json::json;

fn main() -> Result<(), String> {
	let session = dispatch(&json!({
		"op": "start", "evidence": { "health": { "healthy": false } }
	}).to_string())?;
	assert!(session["agent"].is_object());
	Ok(())
}
```

Typed APIs include `Config::parse`, `Session`, `tool_decision`, and `telemetry::Signal::parse_batch`. Hosts must enforce durable budgets and single-use action claims, supply actual approval authority, redact evidence before sending it to the provider, and verify recovery independently. The library's decision cannot replace those host responsibilities.

`Config::parse` preflights each monitor's provider request through Rotary, rejecting invalid model identifiers and configured tool schemas that cannot fit its context bound. Runtime evidence and conversation growth still require the separate request-time size checks.

Anthropic thinking/signature blocks are returned unchanged to the same provider for tool continuation. They are excluded from the investigation summary. Do not log raw provider conversations.

## Validate and package

From the repository root:

```sh
cargo fmt --manifest-path crates/roundhouse-core/Cargo.toml --check
cargo clippy --locked --manifest-path crates/roundhouse-core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path crates/roundhouse-core/Cargo.toml
cargo build --locked --manifest-path crates/roundhouse-core/Cargo.toml --target wasm32-unknown-unknown --release
```

MPL-2.0. Consume Roundhouse from the source repository or a source archive. This build pins published `rx4` 0.8.0 from crates.io. Roundhouse registry publication is excluded; an ordinary registry-ready `.crate` is not claimed.
