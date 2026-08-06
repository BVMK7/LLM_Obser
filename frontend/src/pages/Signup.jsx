import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../AuthContext";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") || "/";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signup(email, password, name || undefined);
      navigate(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--bg-app)]">
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--bg-card)] border border-[var(--border-subtle)] p-8 w-full max-w-sm"
      >
        <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-1">Create your account</h1>
        <p className="text-sm text-[var(--text-muted)] mb-6">Own your projects, invite your team, manage billing.</p>

        {error && <div className="text-sm text-[var(--brand-danger)] mb-4">{error}</div>}

        <label className="block text-xs text-[var(--text-muted)] mb-1">Name</label>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] mb-4 focus:outline-none focus:border-[var(--brand-primary)]"
        />

        <label className="block text-xs text-[var(--text-muted)] mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] mb-4 focus:outline-none focus:border-[var(--brand-primary)]"
        />

        <label className="block text-xs text-[var(--text-muted)] mb-1">Password</label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] mb-6 focus:outline-none focus:border-[var(--brand-primary)]"
        />

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-[var(--brand-primary)] text-white text-sm font-medium px-3 py-2 hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>

        <p className="text-xs text-[var(--text-muted)] mt-4 text-center">
          Already have an account?{" "}
          <Link
            to={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`}
            className="text-[var(--brand-primary)] hover:underline"
          >
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
