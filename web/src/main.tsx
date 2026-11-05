import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import "./index.css"
import { router } from "./app/router"
import { startLogsSync } from "./lib/logs"
import { startServerSync } from "./lib/server"
import { useWs } from "./lib/ws"

startServerSync()
startLogsSync()
useWs.getState().connect()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
