import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { SunIcon, MoonIcon, AlertsIcon } from "./icons";
import { useAuth } from "../AuthContext";
import { usePlatformTheme } from "../ThemeContext";

// Full-width chrome bar above the page content. Per product decision, the
// notification bell is static decoration; the theme toggle, search box (on
// the Traces page), and logout button are wired to real behavior.
export default function Topbar() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = usePlatformTheme();
  const isTracesPage = location.pathname === "/traces";

  const handleLogout = () => {
    logout().then(() => window.location.assign("/login"));
  };
  // Kept as a fallback so the input stays controlled (avoids a React
  // controlled/uncontrolled warning) when navigating off the Traces page.
  const [decorativeQuery, setDecorativeQuery] = useState("");

  const handleSearchChange = (e) => {
    if (!isTracesPage) {
      setDecorativeQuery(e.target.value);
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (e.target.value) next.set("q", e.target.value);
    else next.delete("q");
    setSearchParams(next);
  };

  const initials = (user?.email || "?").slice(0, 2).toUpperCase();

  return (
    <header className="h-16 shrink-0 flex items-center justify-between px-6 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span>Workspace</span>
        <span>/</span>
        <span className="text-[var(--text-primary)] font-medium">InferenceIQ</span>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative hidden sm:block">
          <input
            type="text"
            placeholder={isTracesPage ? "Search traces, users, or models..." : "Search anything..."}
            value={isTracesPage ? searchParams.get("q") || "" : decorativeQuery}
            onChange={handleSearchChange}
            className="w-72 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg pl-3 pr-10 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)] rounded px-1 py-0.5">
            ⌘K
          </span>
        </div>
        <button
          onClick={toggleTheme}
          title={theme === "light" ? "Switch to dark canvas" : "Switch to light canvas"}
          className="w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-overlay)] transition-colors"
        >
          {theme === "light" ? <MoonIcon className="w-[16px] h-[16px]" /> : <SunIcon className="w-[16px] h-[16px]" />}
        </button>
        {/* Static, decorative — no notification backend yet */}
        <span
          title="Notifications"
          className="w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] cursor-default"
        >
          <AlertsIcon className="w-[16px] h-[16px]" />
        </span>
        <button
          onClick={handleLogout}
          title={user ? `Log out (${user.email})` : "Log out"}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--brand-primary)_14%,transparent)] text-[var(--brand-primary)] text-xs font-semibold hover:opacity-80 transition-opacity"
        >
          {initials}
        </button>
      </div>
    </header>
  );
}
