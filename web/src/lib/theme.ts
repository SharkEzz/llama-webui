import { create } from "zustand"
import type { Settings, ThemeMode } from "@llama-webui/shared"
import { api } from "./api"

const KEY = "llama-webui:theme"
const media = window.matchMedia("(prefers-color-scheme: dark)")

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

const resolve = (mode: ThemeMode): "light" | "dark" => (mode === "system" ? (media.matches ? "dark" : "light") : mode)

function apply(mode: ThemeMode): "light" | "dark" {
  const resolved = resolve(mode)
  const root = document.documentElement
  root.classList.toggle("dark", resolved === "dark")
  root.style.colorScheme = resolved
  try {
    localStorage.setItem(KEY, mode)
  } catch {}
  return resolved
}

interface ThemeState {
  mode: ThemeMode
  resolved: "light" | "dark"
  /** Applique le thème, le garde dans le navigateur et en base. */
  setMode(mode: ThemeMode): void
}

export const useTheme = create<ThemeState>((set) => {
  const mode = stored()
  return {
    mode,
    resolved: resolve(mode),
    setMode(next) {
      set({ mode: next, resolved: apply(next) })
      api<Settings>("/settings", { method: "PATCH", body: JSON.stringify({ theme: next }) }).catch(() => {})
    },
  }
})

/** Suit prefers-color-scheme en mode Système ; la base fait foi au démarrage (choix fait depuis un autre navigateur). */
export function startThemeSync() {
  media.addEventListener("change", () => {
    const { mode } = useTheme.getState()
    if (mode === "system") useTheme.setState({ resolved: apply("system") })
  })
  api<Settings>("/settings")
    .then((s) => {
      if (s.theme !== useTheme.getState().mode) useTheme.setState({ mode: s.theme, resolved: apply(s.theme) })
    })
    .catch(() => {})
}
