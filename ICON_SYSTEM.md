# Icon System

Source of truth for this app's icon set. Captured here so it survives even if
the original reference image isn't available in a future session — a new
chat can read this file instead of needing the image re-shared.

## Style spec

Every icon is a hand-authored inline SVG (no icon-font, no npm icon package):

- `viewBox="0 0 24 24"`, `width`/`height` set by the caller (sidebar uses 18px)
- `fill="none"`, `stroke="currentColor"` — always inherits the surrounding
  text color, so active/hover states recolor the icon automatically
- `strokeWidth="1.75"`, `strokeLinecap="round"`, `strokeLinejoin="round"`
- Thin outline style, no filled shapes, one visual weight across the whole set

This replaces the old approach of bare Unicode characters as icons (`"⚡"`,
`"☆"`, `"$"`, etc.). One of those (`⚡`, U+26A1 HIGH VOLTAGE SIGN) turned out
to render as a full-color emoji glyph by default in the browser instead of
inheriting the surrounding text color — a real SVG with `stroke="currentColor"`
removes that entire class of bug, for every icon, permanently.

## Full inventory

The reference image had ~40 icons across five rows. Name → one-line visual
description, so a future session can implement any of the not-yet-wired-up
ones consistently without needing the original image.

### Row 1 — Monitoring
| Name | Description |
|---|---|
| Overview | 2×2 grid of small squares |
| Traces | jagged pulse/activity line |
| Live Requests | lightning bolt |
| Sessions | two overlapping speech/person shapes |
| Logs | document with horizontal list lines |
| Alerts | bell |
| Playground | code brackets `</>` |
| Evaluation | five-point star outline |

### Row 2 — Evaluation & Management
| Name | Description |
|---|---|
| Models | 3D cube (isometric box) |
| Datasets | stacked database cylinder |
| Prompts | speech bubble |
| Experiments | flask/beaker |
| Evaluations | checklist (lines with checkmarks) |
| Guardrails | shield with checkmark |
| Annotations | pencil (edit) |
| Benchmark | gauge/speedometer with needle |

### Row 3 — Analytics
| Name | Description |
|---|---|
| Cost & Usage | dollar sign in a circle |
| Quality | ribbon/medal |
| Providers | cloud |
| Performance | gauge/speedometer with needle |
| Drift | wavy/erratic line |
| Feedback | thumbs up |
| Integrations | puzzle piece |
| Settings | gear |

### Row 4 — Org / infra
| Name | Description |
|---|---|
| Team | two people |
| API Keys | key |
| Webhooks | anchor/hook |
| Environments | stacked layers |
| Deployments | cloud with upward arrow |
| Pipelines | connected nodes |
| Dashboard | pie chart |
| Reports | bar chart inside a frame |

### Row 5 — Actions
| Name | Description |
|---|---|
| Search | magnifying glass |
| Filter | funnel |
| Calendar | calendar grid |
| Download | downward arrow into a tray |
| Upload | upward arrow out of a tray |
| Copy | two overlapping squares |
| Share | connected share nodes |
| More | three vertical dots |

## Implemented today

Only the icons this app actually uses are wired up as real components, in
`frontend/src/components/icons.jsx`: `OverviewIcon`, `TracesIcon`,
`PerformanceIcon`, `CostUsageIcon`, `ProvidersIcon`, `PlaygroundIcon`,
`EvaluationIcon`, `DatasetsIcon`, `ModelsIcon`, `PromptsIcon`, `SettingsIcon`,
`DocumentationIcon` (no exact match in the reference — modeled on the "Logs"
document-with-lines look, since "documentation" is the closest existing
concept). Used in `frontend/src/components/Sidebar.jsx`.

Everything else in the inventory above (Live Requests, Sessions, Alerts,
Experiments, Evaluations, Guardrails, Annotations, Benchmark, Quality, Drift,
Feedback, Integrations, Team, API Keys, Webhooks, Environments, Deployments,
Pipelines, Dashboard, Reports, Search, Filter, Calendar, Download, Upload,
Copy, Share, More) is documented here for whenever those pages/features get
built — implement them the same way (same style spec) rather than reaching
for a different icon source.
