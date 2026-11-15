# Third-party notices

Roundhouse is MPL-2.0 software. Both hosts depend on Rotary (`rx4`), also MPL-2.0, at the public revision pinned by their Cargo manifests and lockfiles.

The portable crate depends on Rotary's `lite` feature. Its agent, permission evaluator and redactor come from that dependency, not Roundhouse copies. The matching MPL-2.0 text is included in the root, Rust source, and npm package. [UPSTREAM.md](crates/roundhouse-core/UPSTREAM.md) identifies the pinned source and portable-runtime boundary. The npm archive includes the matching Rotary source in `rust/rotary/`; covered files remain available under MPL-2.0.

The bridge design follows an inspected direct wasm-bindgen example in `tschk/eqts`, revision `db4793b6b56963aeb8885e69ec37071473cd079c` (ISC). No eqts source is copied, and eqts is not a runtime dependency.

The npm package bundles the portable crate, wasm-bindgen glue, and a precompiled Wasm module. It also includes the exact portable source in `rust/` and actual dependency license files in `licenses/`. Its Rust transitive dependencies retain their own licenses. `Cargo.lock` files and `npm/bun.lock` pin the inspected package graph. The npm host and client have no runtime npm dependencies; development tools are not redistributed as package runtime code.

The source/dependency audit uses `cargo metadata --locked --format-version 1` for each Cargo manifest and the locked npm graph. MPL-2.0 components are kept under MPL-2.0; other inspected dependencies provide permissive license choices. This is not permission to remove dependency copyrights or notices. Re-audit after dependency updates and before a binary or registry release.

No implementation, asset, or proprietary enterprise code is copied from PostHog, Better Stack, SigNoz, OpenObserve, Grafana, Loki, Tempo, Prometheus, Uptime Kuma, or OpenTelemetry. Their API documentation and open-source architecture informed original code and the [coverage comparison](docs/observability.md). That comparison records commercial-directory exceptions and does not relicense those projects.
