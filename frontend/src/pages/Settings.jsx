import { useEffect, useState } from "react";
import { getProviderStatus } from "../api";

export default function Settings() {
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
