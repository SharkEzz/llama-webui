import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useServer } from "@/lib/server"

/** Ce que /props de llama-server dit du sampling par défaut, du contexte et du modèle chargé. */
export interface ServerProps {
  model_path?: string
  default_generation_settings?: { n_ctx?: number; params?: Record<string, unknown> }
}

/** /props du serveur prêt (relu à chaque changement d'état), sinon null. */
export function useServerProps(): ServerProps | null {
  const kind = useServer((s) => s.view?.state.kind)
  const pid = useServer((s) => (s.view && "pid" in s.view.state ? s.view.state.pid : null))
  const [props, setProps] = useState<ServerProps | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pid est un déclencheur : /props est relu à chaque redémarrage du serveur
  useEffect(() => {
    if (kind !== "ready" && kind !== "external") {
      setProps(null)
      return
    }
    let live = true
    api<ServerProps>("/server/props").then(
      (p) => live && setProps(p),
      () => live && setProps(null),
    )
    return () => {
      live = false
    }
  }, [kind, pid])
  return props
}
