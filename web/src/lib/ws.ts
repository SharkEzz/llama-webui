import { create } from "zustand"
import type { WsMessage } from "@llama-webui/shared"

export type WsStatus = "connecting" | "open" | "closed"

interface WsState {
  status: WsStatus
  lastMessage?: WsMessage
  connect(): void
}

const BACKOFF_START_MS = 500
const BACKOFF_MAX_MS = 10_000

type Listener = (msg: WsMessage) => void
const listeners = new Map<WsMessage["type"], Set<Listener>>()

/** Abonnement aux messages WS d'un type donné. */
export function onWs<T extends WsMessage["type"]>(type: T, fn: (msg: Extract<WsMessage, { type: T }>) => void): () => void {
  let set = listeners.get(type)
  if (!set) listeners.set(type, (set = new Set()))
  set.add(fn as Listener)
  return () => set.delete(fn as Listener)
}

let socket: WebSocket | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let backoff = BACKOFF_START_MS
let started = false

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${location.host}/ws`
}

/** Connexion WebSocket unique, reconnexion automatique (backoff 500 ms × 2, plafond 10 s). */
export const useWs = create<WsState>()((set, get) => {
  const open = () => {
    retryTimer = undefined
    // Après une première coupure on reste « closed » pendant les tentatives, pour ne pas clignoter.
    if (get().status !== "closed") set({ status: "connecting" })
    const ws = new WebSocket(wsUrl())
    socket = ws

    ws.onopen = () => {
      backoff = BACKOFF_START_MS
      set({ status: "open" })
    }
    ws.onmessage = (event) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof msg !== "object" || msg === null) return
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies WsMessage))
      set({ lastMessage: msg })
      for (const fn of listeners.get(msg.type) ?? []) fn(msg)
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = undefined
      set({ status: "closed" })
      retryTimer = setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
    // onerror est toujours suivi de onclose : rien à faire ici.
  }

  return {
    status: "connecting",
    connect() {
      if (started) return
      started = true
      open()
    },
  }
})

/** Libellé et couleur de la pastille d'état. */
export const WS_STATUS_UI: Record<WsStatus, { label: string; tone: "ok" | "wait" | "down" }> = {
  open: { label: "Connecté", tone: "ok" },
  connecting: { label: "Connexion…", tone: "wait" },
  closed: { label: "Déconnecté", tone: "down" },
}

// Évite les sockets fantômes lors du rechargement à chaud de Vite.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (retryTimer) clearTimeout(retryTimer)
    const ws = socket
    socket = undefined
    ws?.close()
    started = false
  })
}
