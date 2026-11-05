import { useEffect } from "react"
import { Outlet } from "react-router"
import { AuroraBackground } from "@/components/glass/AuroraBackground"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useHealth } from "@/lib/health"
import { useWs } from "@/lib/ws"
import { Sidebar } from "./Sidebar"
import { StatusBar } from "./StatusBar"

export function AppLayout() {
  const status = useWs((s) => s.status)
  const refreshHealth = useHealth((s) => s.refresh)

  // À chaque (re)connexion, on relit l'état du serveur.
  useEffect(() => {
    if (status === "open") void refreshHealth()
  }, [status, refreshHealth])

  return (
    <TooltipProvider>
      <AuroraBackground />
      <div className="grid h-dvh grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)]">
        <Sidebar />
        <ScrollArea className="h-dvh">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 pt-4 pb-10 lg:px-10">
            <StatusBar />
            <main>
              <Outlet />
            </main>
          </div>
        </ScrollArea>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
