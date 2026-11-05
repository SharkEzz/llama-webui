import { createBrowserRouter } from "react-router"
import { HomePage } from "@/features/home/HomePage"
import { PlaceholderPage } from "@/features/_placeholder/PlaceholderPage"
import { AppLayout } from "./AppLayout"
import { ROUTES } from "./routes"

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      ...ROUTES.filter((r) => r.path !== "/").map((r) => ({
        path: r.path.slice(1),
        element: <PlaceholderPage title={r.label} />,
      })),
      { path: "*", element: <PlaceholderPage title="Page introuvable" /> },
    ],
  },
])
