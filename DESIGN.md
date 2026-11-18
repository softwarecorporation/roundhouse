# Signal desk

## References and decision

- [Photon](https://photon.codes/), inspected live: decisive type, direct entry, one page-scale composition. Borrow its confidence, not gradients, pills, customer claims or illustrations.
- [Foglamp](https://foglamp.dev), inspected live and through its docs: concrete product graphics and concise agent observability. Borrow information hierarchy, not branding or feature claims. [Capability inventory](docs/foglamp-comparison.md) separates implemented behavior from gaps.
- [GOV.UK tables](https://design-system.service.gov.uk/components/table/): aligned data and explicit row actions. Borrow readable tables, not its brand.
- A railway roundhouse supplies the literal drawn logo and the relationship to Rotary. Do not turn the whole interface into a station costume.

Compared three directions before implementation: Signal desk (dark, compact operational rows); Operations ledger (all-light register); Incident dossier (case-first split view). Choose Signal desk for Roundhouse, with a white reporting canvas for Reportroom. Dossier overemphasizes exceptional recovery; an all-dark reporting canvas makes everyday table work harder. The old orbit/card landing and cream recovery dashboard are rejected.

## Typography
Self-host Archivo under its SIL Open Font License. Landing display 64–96px, -0.035em tracking; workspace title 28–36px. Body 14–16px, labels at least 12px. Monospace only for IDs, timestamps and code. Tabular numbers in reports. No uppercase eyebrows.

## Color
Roundhouse canvas #101112; text #f5f5f3; secondary #a9adb3; rules #343638. Acid yellow #e5ed66 is reserved for primary actions, links and the mark. No glows or gradients.

Reportroom canvas #ffffff; text #17191c; secondary #58616d; rules #dce0e5. Blue #2158cf identifies report actions and actual data. Dark navigation relates it to Roundhouse without making recovery the product.

## Hierarchy and layout
Roundhouse landing: short headline, action, an original signal-routing graphic and mechanism specimen labeled illustrative. Console: connected apps, automation configuration, current state, next action, run evidence, history and limits. Reportroom is an explicitly marked example. No equal-weight decorative card grid.

Reportroom: workspace navigation, report creation, real report history and detail; overview uses actual synthetic order totals and daily data. Onboarding is inline. Roundhouse and optional faults have their own view. Preferences persist server-side. Empty, pending, failed and ready states have explicit text and a next action.

## Spacing and controls
4px base; 8px related items, 16px controls, 24–32px sections, 48px page margins. Flat surfaces separated by whitespace or a single rule. Radius 0–3px. No redundant frames or shadows. Controls at least 40px tall, 44px on narrow screens. Visible keyboard focus, native labels, semantic tables, no color-only state.

## Narrow screens
Navigation becomes a horizontal labeled rail; forms stack. Tables scroll inside labeled regions rather than overflowing the page. Core report actions remain visible. Reduced motion disables transitions. No hover-only functionality.

## Copy
Headlines and controls do the explaining. Keep safety information at the relevant setting or action. Synthetic data is labeled; no commercial claims, mock integrations or invented telemetry.

Company attribution is **Roundhouse by Software Corp**. Rotary belongs in technical documentation. Automated actions remain bounded by configured targets, tools and limits; approval is opt-in for newly configured actions. Provider-run usage is reported usage, not actual billed spend.

## Connected-app ownership
One controller owns each tenant's app configurations, serial scheduling, execution history and aggregate limits. App IDs are monitor IDs. App configuration stays separate from the synthetic reporting database. Adding per-app Durable Objects was rejected for this wave because it would require a second global budget coordinator and more tenant routing without improving the current serial scheduler contract. Configuration changes require monitoring stopped and no unresolved incident. Existing Reportroom-only config order and explicit manual policies remain unchanged.

## Asset provenance
`platform/public/roundhouse.svg`: generated with Painter for this project, depicting five arched shed doors, radial tracks and a turntable. Inspect at 24/40/64px on white and dark backgrounds. Fonts retain their upstream license.
