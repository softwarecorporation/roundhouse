# Rotary lite dependency

Both Roundhouse hosts depend on tschk/rotary under MPL-2.0. Their Cargo manifests
pin published `rx4 = "=0.8.0"`; lockfiles record its registry checksum. That release
comes from source commit `c0a6696004ea1fb21dbefbb80908b684c1d770a6` and includes the
SQLite and rustix security updates. The Workers bridge enables only `lite` and
uses the real `rx4::lite::Agent`; the native server enables native providers and
uses `rx4::Agent`. The agent owns provider conversations, call parsing and result
bookkeeping. Roundhouse owns monitoring, application schemas, exact action
authority, network I/O, durable limits/history, and independent verification.

Rotary 0.8 isolates its native dependencies from the portable feature set. The
previous 0.7.5 revision still enabled Tokio filesystem features with defaults
disabled and could not compile for Workers. Roundhouse's interim copied security
modules and separate provider driver were removed. Shared security and the lite
agent now come directly from the dependency. The npm archive includes matching
Rotary source in `rust/rotary/` and its license. Neither full native Agent parity
nor native filesystem/process/MCP/streaming support in Workers is claimed.

The npm build follows the direct wasm-bindgen bridge in eqts's
`examples/backend-parity/wasm`, inspected at
`db4793b6b56963aeb8885e69ec37071473cd079c`. Workers import a precompiled Wasm
module and use synchronous initialization; they do not fetch/compile Wasm at
runtime. No eqts source is copied and no native addon or Docker is required.
