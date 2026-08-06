import { createContext, useContext, useEffect, useState } from "react";
import { getMe, getUserToken, setUserToken, login as apiLogin, signup as apiSignup, logout as apiLogout } from "./api";

// Separate entirely from the project API-key system (see api.js) — this is
// the logged-in human account used only for project management (settings,
// team, api-keys, billing), never for trace ingestion.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getUserToken()) {
      setLoading(false);
      return;
    }
    getMe()
      .then(setUser)
      .catch(() => setUserToken(""))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { user: loggedInUser, session_token } = await apiLogin({ email, password });
    setUserToken(session_token);
    setUser(loggedInUser);
  };

  const signup = async (email, password, name) => {
    const { user: newUser, session_token } = await apiSignup({ email, password, name });
    setUserToken(session_token);
    setUser(newUser);
  };

  const logout = async () => {
    try {
      await apiLogout();
    } catch {
      // Session may already be invalid — clear local state regardless.
    }
    setUserToken("");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
