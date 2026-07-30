import { useEffect, useState } from "react";

// Reads/writes the "dark" | "light" theme choice, and mirrors it onto
// <html data-theme="..."> so every component's CSS-var-based colors
// (see index.css) update instantly without prop drilling.
export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return [theme, toggleTheme];
}
