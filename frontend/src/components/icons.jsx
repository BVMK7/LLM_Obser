// Shared icon set for the sidebar — see ICON_SYSTEM.md at the repo root for
// the full reference inventory and style spec. These replace bare
// Unicode-character icons (one of which, "⚡", rendered as a full-color
// emoji glyph instead of inheriting the surrounding text color); every icon
// here is stroke="currentColor" so it always recolors correctly with the
// active/hover state.
function IconBase({ children, className = "w-[18px] h-[18px]" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </IconBase>
  );
}

export function TracesIcon(props) {
  return (
    <IconBase {...props}>
      <polyline points="2 12 7 12 9 5 13 19 16 12 22 12" />
    </IconBase>
  );
}

export function PerformanceIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <line x1="12" y1="15" x2="16" y2="9" />
      <circle cx="12" cy="15" r="1" />
    </IconBase>
  );
}

export function CostUsageIcon(props) {
  return (
    <IconBase {...props}>
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M16.5 6.5H9.75a2.75 2.75 0 0 0 0 5.5h4.5a2.75 2.75 0 0 1 0 5.5H7" />
    </IconBase>
  );
}

export function ProvidersIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M6.5 19a4.5 4.5 0 0 1-.5-8.98A5 5 0 0 1 15.9 8.02 4.5 4.5 0 0 1 17.5 19h-11z" />
    </IconBase>
  );
}

export function PlaygroundIcon(props) {
  return (
    <IconBase {...props}>
      <polyline points="8 6 3 12 8 18" />
      <polyline points="16 6 21 12 16 18" />
    </IconBase>
  );
}

export function EvaluationIcon(props) {
  return (
    <IconBase {...props}>
      <polygon points="12 2 14.9 8.5 22 9.2 16.5 14 18.2 21 12 17.3 5.8 21 7.5 14 2 9.2 9.1 8.5" />
    </IconBase>
  );
}

export function DatasetsIcon(props) {
  return (
    <IconBase {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </IconBase>
  );
}

export function PromptsIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
    </IconBase>
  );
}

export function ScorersIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </IconBase>
  );
}

export function ExperimentsIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M9 2v6L4 18a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3L15 8V2" />
      <path d="M9 2h6" />
      <path d="M7 15h10" />
    </IconBase>
  );
}

export function AlertsIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </IconBase>
  );
}

export function ReviewIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </IconBase>
  );
}

export function SettingsIcon(props) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </IconBase>
  );
}

export function DocumentationIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </IconBase>
  );
}

// The brand mark shown in the Topbar's badge, in place of a plain "O" —
// a bold rounded desk-lamp silhouette (swivel-arm lamp, angled shade,
// pill-shaped foot), matching the thick-stroke reference icon supplied.
export function LampIcon({ className = "w-[18px] h-[18px]" }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="6.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M46 18 54 26 46 34 38 26Z" />
      <path d="M50 21 88 34Q94 36 90 41L57 53Z" />
      <path d="M40 27Q19 30 19 44L19 66" />
      <rect x="7" y="66" width="24" height="16" rx="8" />
    </svg>
  );
}

// Stand-in for a provider we can't identify (e.g. "unknown" from
// manually-inserted trace rows) — shown next to that row instead of a
// real provider logo.
export function UnknownProviderIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M5 20V11a7 7 0 0 1 14 0v9l-3.5-2-3.5 2-3.5-2L5 20Z" />
      <circle cx="9.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

// Auth pages' background theme toggle (see AuthShell.jsx).
export function SunIcon(props) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.22 4.22l1.77 1.77M18.01 18.01l1.77 1.77M2 12h2.5M19.5 12H22M4.22 19.78l1.77-1.77M18.01 5.99l1.77-1.77" />
    </IconBase>
  );
}

export function MoonIcon(props) {
  return (
    <IconBase {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </IconBase>
  );
}
