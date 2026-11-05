import { createBrowserRouter } from "react-router"
import { DashboardPage } from "@/features/dashboard/DashboardPage"
import { HomePage } from "@/features/home/HomePage"
import { PlaceholderPage } from "@/features/_placeholder/PlaceholderPage"
import { LogsPage } from "@/features/logs/LogsPage"
import { ProfilesPage } from "@/features/profiles/ProfilesPage"
import { ServerPage } from "@/features/server/ServerPage"
import { AppLayout } from "./AppLayout"
import { ROUTES } from "./routes"

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "dashboard", element: <DashboardPage /> },
      { path: "server", element: <ServerPage /> },
      { path: "profiles", element: <ProfilesPage /> },
      { path: "logs", element: <LogsPage /> },
      ...ROUTES.filter((r) => !["/", "/dashboard", "/server", "/profiles", "/logs"].includes(r.path)).map((r) => ({
        path: r.path.slice(1),
        element: <PlaceholderPage title={r.label} />,
      })),
      { path: "*", element: <PlaceholderPage title="Page introuvable" /> },
    ],
  },
])
