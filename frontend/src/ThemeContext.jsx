import { createContext, useContext, useState } from "react";

// Platform-wide light/dark toggle — scoped to the page canvas and the text
// sitting directly on it (see .app-shell in index.css). Sidebar/Topbar/cards
// keep their fixed dark-navy look in both themes, unchanged.
const ThemeContext = createContext(null);

const STORAGE_KEY = "llmobs_platform_theme";

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEY) || "light");

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function usePlatformTheme() {
  return useContext(ThemeContext);
}
