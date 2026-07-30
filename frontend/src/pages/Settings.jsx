import { useEffect, useState } from "react";
import { getProviderStatus } from "../api";
import { useTheme } from "../theme";

export default function Settings() {
  const [theme, toggleTheme] = useTheme();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getProviderStatus()
      .then(setStatus)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">Settings</h1>
      <p className="text-sm text-[var(--text-muted)] mb-6">App preferences and provider configuration.</p>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 mb-6 max-w-md">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-3">Appearance</div>
        <div className="flex gap-2">
          <button
            onClick={() => theme !== "dark" && toggleTheme()}
            className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${
              theme === "dark"
                ? "bg-[var(--brand-primary)] text-white"
                : "bg-white/5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Dark
          </button>
          <button
            onClick={() => theme !== "light" && toggleTheme()}
            className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${
              theme === "light"
                ? "bg-[var(--brand-primary)] text-white"
                : "bg-white/5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Light
          </button>
        </div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl p-4 max-w-md">
        <div className="text-sm font-medium text-[var(--text-primary)] mb-1">Providers</div>
        <div className="text-xs text-[var(--text-muted)] mb-3">
          Whether each provider's API key is set in your .env file.
        </div>

        {error && <div className="text-sm text-red-400">Couldn't load provider status ({error})</div>}

        {status && (
          <div className="flex flex-col gap-2">
            {Object.entries(status).map(([provider, configured]) => (
              <div key={provider} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-[var(--text-primary)] capitalize">
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: configured ? "var(--brand-success)" : "var(--brand-danger)" }}
                  />
                  {provider}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {configured ? "configured" : "not configured"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
