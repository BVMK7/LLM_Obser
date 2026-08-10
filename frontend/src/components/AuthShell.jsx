import { useState } from "react";
import { MoonIcon, SunIcon } from "./icons";

const STORAGE_KEY = "llmobs_auth_theme";

// Shared page shell for Login/Signup — the sunburst+grid background (see
// .auth-page in index.css) with a toggle between its dark (grey) and light
// variant. The login/signup card itself stays the fixed dark card used
// everywhere else in the app; only the page background recolors.
export default function AuthShell({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) || "dark");

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <div className="auth-page h-screen flex items-center justify-center" data-theme={theme}>
      <button
        type="button"
        onClick={toggleTheme}
        className="auth-theme-toggle"
        aria-label="Toggle background theme"
        title={theme === "dark" ? "Switch to light background" : "Switch to dark background"}
      >
        {theme === "dark" ? <SunIcon className="w-[16px] h-[16px]" /> : <MoonIcon className="w-[16px] h-[16px]" />}
      </button>
      {children}
    </div>
  );
}
