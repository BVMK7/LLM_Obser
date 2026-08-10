import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import ProjectSwitcher from "./ProjectSwitcher";
import { LampIcon, MoonIcon, SunIcon } from "./icons";
import { useAuth } from "../AuthContext";
import { usePlatformTheme } from "../ThemeContext";

// Full-width chrome bar above the page content. Per product decision, the
// avatar is static decoration; the search box (on the Traces page) and the
// logout button are wired to real behavior.
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

  return (
    <header className="h-16 shrink-0 flex items-center justify-between px-6 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)]">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-8 h-8 bg-[var(--brand-primary)] flex items-center justify-center text-white">
            <LampIcon className="w-5 h-5" />
          </div>
          <div>
            <div className="font-semibold text-sm text-[var(--text-primary)] leading-tight">Observability</div>
            <div className="text-[10px] text-[var(--text-muted)] leading-tight">Powered by Tao Digital</div>
          </div>
        </div>
        <input
          type="text"
          placeholder={isTracesPage ? "Search traces, users, or models..." : "Search..."}
          value={isTracesPage ? searchParams.get("q") || "" : decorativeQuery}
          onChange={handleSearchChange}
          className="hidden sm:block w-72 bg-[var(--bg-input)] border border-[var(--border-subtle)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
        />
        {/* Static, decorative connection indicator */}
        <span className="hidden md:flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-[var(--brand-success)]/40 bg-[color-mix(in_srgb,var(--brand-success)_8%,transparent)] text-[var(--brand-success)] cursor-default">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-success)] animate-pulse inline-block" />
          Live Terminal
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ProjectSwitcher />
        <button className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-[var(--brand-primary)] to-[var(--brand-danger)] text-white text-sm font-medium hover:opacity-90 transition-opacity">
          Deploy Model
        </button>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-success)]" />
        <button
          onClick={toggleTheme}
          title={theme === "light" ? "Switch to dark canvas" : "Switch to light canvas"}
          className="w-8 h-8 flex items-center justify-center border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          {theme === "light" ? <MoonIcon className="w-[16px] h-[16px]" /> : <SunIcon className="w-[16px] h-[16px]" />}
        </button>
        <button
          onClick={handleLogout}
          title={user ? `Log out (${user.email})` : "Log out"}
          className="w-8 h-8 flex items-center justify-center border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--brand-danger)] hover:border-[var(--brand-danger)]/50 transition-colors text-xs"
        >
          ⏻
        </button>
      </div>
    </header>
  );
}
