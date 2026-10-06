import { useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "veilbird-console-theme";

function read(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}

/** "system" leaves data-theme unset so the prefers-color-scheme media query decides. */
export function applyTheme(choice: ThemeChoice = read()) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", choice);
  const dark = choice === "dark" || (choice === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0f0c" : "#f3f5f0");
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  return [choice, (next) => {
    try { if (next === "system") window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, next); } catch { /* storage blocked: keep for this tab only */ }
    applyTheme(next); setChoice(next);
  }];
}
