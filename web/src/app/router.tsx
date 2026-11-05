import { createBrowserRouter } from "react-router"
import { HomePage } from "@/features/home/HomePage"
import { PlaceholderPage } from "@/features/_placeholder/PlaceholderPage"
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
      { path: "server", element: <ServerPage /> },
      { path: "profiles", element: <ProfilesPage /> },
      ...ROUTES.filter((r) => !["/", "/server", "/profiles"].includes(r.path)).map((r) => ({
        path: r.path.slice(1),
        element: <PlaceholderPage title={r.label} />,
      })),
      { path: "*", element: <PlaceholderPage title="Page introuvable" /> },
    ],
  },
])
