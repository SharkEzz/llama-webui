import type { ServerView } from "@llama-webui/shared"
import { toast } from "sonner"
import { create } from "zustand"
import { ApiError, api } from "./api"
import { onWs, useWs } from "./ws"

interface ServerStore {
  view: ServerView | null
  /** Une action de cycle de vie est en cours côté client. */
  busy: boolean
}

export const useServer = create<ServerStore>()(() => ({ view: null, busy: false }))

async function refresh() {
  try {
    const st = await api<{ server: ServerView; logSeq: number }>("/state")
    useServer.setState({ view: st.server })
  } catch {
    // le WS est ouvert mais l'API ne répond pas : la prochaine reconnexion réessaiera
  }
}

let started = false
/** Alimente le store : messages « server-state » + relecture de l'état à chaque (re)connexion. */
export function startServerSync() {
  if (started) return
  started = true
  onWs("server-state", (m) => useServer.setState({ view: m.payload }))
  useWs.subscribe((s, prev) => {
    if (s.status === "open" && prev.status !== "open") void refresh()
  })
}

async function action(path: string, body?: unknown): Promise<boolean> {
  useServer.setState({ busy: true })
  try {
    const view = await api<ServerView>(`/server/${path}`, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    useServer.setState({ view })
    return true
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : String(e))
    return false
  } finally {
    useServer.setState({ busy: false })
  }
}

export const startProfile = (profileId: number) => action("start", { profileId })
export const switchProfile = (profileId: number) => action("switch", { profileId })
export const restartServer = () => action("restart")
export const stopServer = () => action("stop")

/** Le serveur tourne (géré) : on peut l'arrêter, le redémarrer ou basculer. */
export const isRunning = (v: ServerView | null) => v?.state.kind === "starting" || v?.state.kind === "ready"
