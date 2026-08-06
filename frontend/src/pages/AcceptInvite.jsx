import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { acceptInvite } from "../api";

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("pending"); // pending | done | error
  const [error, setError] = useState(null);

  useEffect(() => {
    if (loading || !user || !token) return;
    acceptInvite(token)
      .then((res) => {
        setStatus("done");
        setTimeout(() => navigate(`/projects/${res.project_id}/settings`), 1200);
      })
      .catch((err) => {
        setError(err.message);
        setStatus("error");
      });
  }, [loading, user, token, navigate]);

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--bg-app)]">
      <div className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-8 w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Project invite</h1>
        {!token && <p className="text-sm text-[var(--brand-danger)]">This invite link is missing its token.</p>}
        {token && loading && <p className="text-sm text-[var(--text-muted)]">Checking your session...</p>}
        {token && !loading && !user && (
          <p className="text-sm text-[var(--text-secondary)]">
            Log in or sign up with the email this invite was sent to, then come back to this link.{" "}
            <Link to={`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`} className="text-[var(--brand-primary)] hover:underline">
              Log in
            </Link>{" "}
            /{" "}
            <Link to={`/signup?next=${encodeURIComponent(window.location.pathname + window.location.search)}`} className="text-[var(--brand-primary)] hover:underline">
              Sign up
            </Link>
          </p>
        )}
        {status === "pending" && user && <p className="text-sm text-[var(--text-muted)]">Joining project...</p>}
        {status === "done" && <p className="text-sm text-[var(--brand-success)]">You're in! Redirecting...</p>}
        {status === "error" && <p className="text-sm text-[var(--brand-danger)]">{error}</p>}
      </div>
    </div>
  );
}
