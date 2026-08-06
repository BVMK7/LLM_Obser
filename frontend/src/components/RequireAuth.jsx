import { Navigate } from "react-router-dom";
import { useAuth } from "../AuthContext";

// Gates project management (everything under the main app shell) behind a
// real logged-in user. Never gates the X-API-Key data plane — that's a
// separate credential entirely (see api.js).
export default function RequireAuth({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="h-screen flex items-center justify-center bg-[var(--bg-app)] text-[var(--text-muted)]">Loading...</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
