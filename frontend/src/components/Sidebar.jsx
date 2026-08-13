import { NavLink } from "react-router-dom";
import {
  OverviewIcon,
  TracesIcon,
  PerformanceIcon,
  CostUsageIcon,
  ProvidersIcon,
  PlaygroundIcon,
  EvaluationIcon,
  DatasetsIcon,
  ScorersIcon,
  ExperimentsIcon,
  PromptsIcon,
  AlertsIcon,
  ReviewIcon,
  SettingsIcon,
  DocumentationIcon,
  AgentsIcon,
  PoliciesIcon,
} from "./icons";

const navSections = [
  {
    label: "Monitoring",
    items: [
      { to: "/", label: "Overview", icon: <OverviewIcon />, end: true },
      { to: "/traces", label: "Traces", icon: <TracesIcon /> },
      { to: "/review", label: "Review Queue", icon: <ReviewIcon /> },
      { to: "/alerts", label: "Alerts", icon: <AlertsIcon /> },
      { to: "/policies", label: "Policies", icon: <PoliciesIcon /> },
    ],
  },
  {
    label: "Analytics",
    items: [
      { to: "/performance", label: "Performance", icon: <PerformanceIcon /> },
      { to: "/cost-usage", label: "Cost & Usage", icon: <CostUsageIcon /> },
      { to: "/providers", label: "Providers & Models", icon: <ProvidersIcon /> },
      { to: "/agents", label: "Agents", icon: <AgentsIcon /> },
    ],
  },
  {
    label: "Evaluation",
    items: [
      { to: "/playground", label: "Playground", icon: <PlaygroundIcon /> },
      { to: "/evaluation", label: "Evaluation", icon: <EvaluationIcon /> },
      { to: "/experiments", label: "Experiments", icon: <ExperimentsIcon /> },
      { to: "/datasets", label: "Datasets", icon: <DatasetsIcon /> },
      { to: "/scorers", label: "Scorers", icon: <ScorersIcon /> },
    ],
  },
  {
    label: "Management",
    items: [
      { to: "/prompt-library", label: "Prompt Library", icon: <PromptsIcon /> },
    ],
  },
];

export default function Sidebar() {
  return (
    <aside className="w-60 shrink-0 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col p-4 overflow-y-auto">
      <nav className="flex flex-col mt-1">
        {navSections.map((section) => (
          <div key={section.label} className="mb-3">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-2 px-3">
              {section.label}
            </div>
            <div className="flex flex-col gap-1">
              {section.items.map((item) => (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? "bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]"
                    }`
                  }
                >
                  <span className="w-[18px] shrink-0 flex items-center justify-center">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 pt-4 border-t border-[var(--border-subtle)]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
              isActive
                ? "bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)]"
                : "text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]"
            }`
          }
        >
          <span className="w-[18px] shrink-0 flex items-center justify-center"><SettingsIcon /></span>
          Settings
        </NavLink>
        {/* Static, decorative — not wired to a real page */}
        <span className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-[var(--text-muted)] cursor-default">
          <span className="w-[18px] shrink-0 flex items-center justify-center"><DocumentationIcon /></span>
          Documentation
        </span>
      </div>
    </aside>
  );
}
