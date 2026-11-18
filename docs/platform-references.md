# Platform references and integration boundaries

Roundhouse's platform code and UI are independently implemented. References inform behavior and safety boundaries; they are not claims of product parity or copied assets.

| Reference | Pattern used or evaluated | License and disposition |
| --- | --- | --- |
| [Umami](https://github.com/umami-software/umami/tree/aad2c4cedd5c0b3bc4d361843830a0bb47cf79c4) | Explicit pageviews and events, SPA navigation, URL normalization | MIT; no source copied |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma/tree/f80642a8e8b2233fbbffe264bd0c8ea2a321b3f2) | Probe observations distinct from incident transitions | MIT; no source copied |
| [OpenStatus](https://github.com/openstatusHQ/openstatus/tree/dc42f497cc35e1a4c54c30edf216c0a0e686068c) | Public status and timestamped operator updates | AGPL-3.0; study only, no schemas, code, or assets transplanted |
| [OpenTelemetry specification](https://github.com/open-telemetry/opentelemetry-specification/tree/a7b22a8d9f26c5b05afbe4d761038444e73c6d61) | Separate event and collection timestamps; service and trace identity | Apache-2.0; no OTLP compatibility claim |
| [MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/d4b317231161ee96d3eefb2448bda4230c76f4c6) | Structured tools and human authority outside agents | Mixed Apache-2.0/MIT transition, documentation CC-BY; no source copied |
| [Photon](https://photon.codes) | Restrained typography, dark canvas, clear information hierarchy | Design principles only; no branding, assets, or source copied |
| [Kitesurf](https://github.com/cloudflare/kitesurf/tree/b9b904e208836b946c6ffc81832ac1ec576ece54) | Workers-native browser, explicit engine selection | Apache-2.0 project; dependencies retain their licenses, including MPL Stylo. Managed binding used, no vendored engine |
| [Computer 0.11.3](https://github.com/cloudflare/computer/tree/9d11fa7b7f77cb8130d3f53f285ba8e0f8ea258b) | Durable workspace and bounded execution evaluated | MIT; not a dependency or enabled runtime |

Kitesurf's public playground was exercised with controlled HTML: title, JavaScript handler, DOM click, text insertion, and rejected fetch interception passed. This is not evidence of arbitrary-site compatibility or of the production binding. Source inspection and a direct timeout probe confirmed unanswered Fetch interception continues after its timeout. Roundhouse therefore does not expose arbitrary browsing or treat CDP interception as sufficient authorization.

Computer's stable filesystem and Codemode backend are implemented upstream. Linux containers, shell emulation, browser modules, replay/restart recovery, and human-answer waits remain experimental. Codemode requires Dynamic Workers on Workers Paid; containers have no Free-plan allocation. The browser module is Chrome/CDP-oriented and is not enabled as a Kitesurf replacement. The clone was inspected, not runtime-tested; the orb has no Docker daemon.

The [platform guide](../platform/README.md) defines what this release exposes. Cloudflare feature availability and pricing must be checked for the operator's account. Free source code is not free unlimited infrastructure or model usage.
