import type { ComponentType } from "react"
import { createBrowserRouter } from "react-router"
import { HomePage } from "@/features/home/HomePage"
import { AppLayout } from "./AppLayout"
import { MILESTONE_BY_PATH, ROUTES } from "./routes"

/**
 * Chaque page est un chunk chargé à la première visite (le bundle initial ne contient que la coquille et l'accueil).
 * `load` doit rester un import() littéral pour que le bundler découpe.
 */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => ({
  lazy: { Component: async () => (await load())[name] },
})

const placeholder = (title: string) => ({
  lazy: {
    Component: async () => {
      const { PlaceholderPage } = await import("@/features/_placeholder/PlaceholderPage")
      return () => <PlaceholderPage title={title} />
    },
  },
})

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    // Premier chargement d'une adresse profonde (/bench rechargé) : la coquille tout de suite, la page ensuite.
    hydrateFallbackElement: <AppLayout loading />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "dashboard", ...page(() => import("@/features/dashboard/DashboardPage"), "DashboardPage") },
      { path: "server", ...page(() => import("@/features/server/ServerPage"), "ServerPage") },
      { path: "profiles", ...page(() => import("@/features/profiles/ProfilesPage"), "ProfilesPage") },
      { path: "logs", ...page(() => import("@/features/logs/LogsPage"), "LogsPage") },
      { path: "system", ...page(() => import("@/features/system/SystemPage"), "SystemPage") },
      { path: "settings", ...page(() => import("@/features/settings/SettingsPage"), "SettingsPage") },
      { path: "models", ...page(() => import("@/features/models/ModelsPage"), "ModelsPage") },
      { path: "chat", ...page(() => import("@/features/chat/ChatPage"), "ChatPage") },
      { path: "chat/:id", ...page(() => import("@/features/chat/ChatPage"), "ChatPage") },
      { path: "bench", ...page(() => import("@/features/bench/BenchPage"), "BenchPage") },
      { path: "tuning", ...page(() => import("@/features/tuning/TuningPage"), "TuningPage") },
      ...ROUTES.filter((r) => r.path in MILESTONE_BY_PATH).map((r) => ({
        path: r.path.slice(1),
        ...placeholder(r.label),
      })),
      { path: "*", ...placeholder("Page introuvable") },
    ],
  },
])
