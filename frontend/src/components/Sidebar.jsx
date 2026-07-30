import { useEffect, useState } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { getTraces } from "../api";
import { extractProvider } from "../utils";
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
  ModelsIcon,
  PromptsIcon,
  AlertsIcon,
  ReviewIcon,
  SettingsIcon,
  DocumentationIcon,
} from "./icons";

const navSections = [
  {
    label: "Monitoring",
    items: [
      { to: "/", label: "Overview", icon: <OverviewIcon />, end: true },
      { to: "/traces", label: "Traces", icon: <TracesIcon /> },
      { to: "/review", label: "Review Queue", icon: <ReviewIcon /> },
      { to: "/alerts", label: "Alerts", icon: <AlertsIcon /> },
    ],
  },
  {
    label: "Analytics",
    items: [
      { to: "/performance", label: "Performance", icon: <PerformanceIcon /> },
      { to: "/cost-usage", label: "Cost & Usage", icon: <CostUsageIcon /> },
      { to: "/providers", label: "Providers", icon: <ProvidersIcon /> },
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
      { to: "/models", label: "Models", icon: <ModelsIcon /> },
      { to: "/prompt-library", label: "Prompt Library", icon: <PromptsIcon /> },
    ],
  },
];

// The Traces page's Provider/Status filters live here (matching the reference
// design's left-rail placement) and are shared with Traces.jsx via URL
// search params — no context or lifted state needed.
function TracesFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    getTraces()
      .then((data) => setProviders(Array.from(new Set(data.map((t) => extractProvider(t.name)))).sort()))
      .catch(() => {});
  }, []);

  const providerFilter = searchParams.get("provider") || "all";
  const statusFilter = new Set((searchParams.get("status") || "").split(",").filter(Boolean));

  const setProviderFilter = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("provider");
    else next.set("provider", value);
    setSearchParams(next);
  };

  const toggleStatus = (status) => {
    const current = new Set(statusFilter);
    if (current.has(status)) current.delete(status);
    else current.add(status);
    const next = new URLSearchParams(searchParams);
    if (current.size === 0) next.delete("status");
    else next.set("status", Array.from(current).join(","));
    setSearchParams(next);
  };

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] px-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-2">Filters</div>

      <label className="block text-xs text-[var(--text-muted)] mb-1">Provider</label>
      <select
        value={providerFilter}
        onChange={(e) => setProviderFilter(e.target.value)}
        className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-2 py-1.5 text-sm text-[var(--text-primary)] mb-3 focus:outline-none focus:border-[var(--brand-primary)]"
      >
        <option value="all">All Providers</option>
        {providers.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <label className="block text-xs text-[var(--text-muted)] mb-1">Status</label>
      <div className="flex gap-2">
        {["success", "error"].map((status) => (
          <button
            key={status}
            onClick={() => toggleStatus(status)}
            className={`text-xs px-2.5 py-1 rounded-lg border capitalize transition-colors ${
              statusFilter.has(status)
                ? "border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_8%,transparent)]"
                : "border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {status}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Sidebar() {
  const location = useLocation();

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
                        ? "bg-[color-mix(in_srgb,var(--brand-success)_10%,transparent)] text-[var(--brand-success)]"
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

      {location.pathname === "/traces" && <TracesFilters />}

      <div className="mt-auto flex flex-col gap-2 pt-4 border-t border-[var(--border-subtle)]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
              isActive
                ? "bg-[color-mix(in_srgb,var(--brand-success)_10%,transparent)] text-[var(--brand-success)]"
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
