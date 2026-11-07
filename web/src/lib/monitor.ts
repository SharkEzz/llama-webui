import type { HistoryDump, Snapshot } from "@llama-webui/shared"
import { create } from "zustand"
import { api } from "./api"
import { onWs, useWs } from "./ws"

/**
 * Historique côté client : instants (s, pour uPlot) et une série par clé, alignées point à point (null = trou).
 * Tableaux mutables, partagés avec les graphes ; `version` change à chaque modification.
 */
export interface ClientHistory {
  intervalMs: number
  capacity: number
  times: number[]
  series: Map<string, (number | null)[]>
}

interface MonitorState {
  snapshot: Snapshot | null
  history: ClientHistory
  version: number
}

const emptyHistory = (): ClientHistory => ({ intervalMs: 1000, capacity: 300, times: [], series: new Map() })

export const useMonitor = create<MonitorState>(() => ({ snapshot: null, history: emptyHistory(), version: 0 }))

/** Série d'historique (alignée sur `history.times`) ; se met à jour avec `version`. */
export function useSeries(key: string): (number | null)[] | undefined {
  useMonitor((s) => s.version)
  return useMonitor.getState().history.series.get(key)
}

function fromDump(d: HistoryDump): ClientHistory {
  return {
    intervalMs: d.intervalMs,
    capacity: d.capacity,
    times: d.times.map((t) => t / 1000),
    series: new Map(Object.entries(d.series)),
  }
}

function append(h: ClientHistory, s: Snapshot) {
  const t = s.at / 1000
  if (h.times.length > 0 && t <= h.times.at(-1)!) return
  h.times.push(t)
  for (const [key, values] of h.series) values.push(s.points[key] ?? null)
  for (const [key, v] of Object.entries(s.points)) {
    if (h.series.has(key)) continue
    const values: (number | null)[] = new Array(h.times.length - 1).fill(null)
    values.push(v)
    h.series.set(key, values)
  }
  const extra = h.times.length - h.capacity
  if (extra > 0) {
    h.times.splice(0, extra)
    for (const values of h.series.values()) values.splice(0, extra)
  }
}

let loading = false
let pending: Snapshot[] = []

/** Relit tout l'historique du serveur (connexion, autre démarrage, forme changée par les réglages). */
export async function reloadHistory() {
  if (loading) return
  loading = true
  pending = []
  try {
    const d = await api<HistoryDump & { bootId: string }>("/monitor/history")
    const h = fromDump(d)
    for (const s of pending) append(h, s)
    useMonitor.setState((st) => ({ history: h, version: st.version + 1 }))
  } catch {
    // WS fermé ou serveur absent : la prochaine connexion relira.
  } finally {
    loading = false
    pending = []
  }
}

export function startMonitorSync() {
  onWs("snapshot", ({ payload: s }) => {
    useMonitor.setState({ snapshot: s })
    if (loading) {
      pending.push(s)
      return
    }
    const h = useMonitor.getState().history
    if (s.history.intervalMs !== h.intervalMs || s.history.capacity !== h.capacity) {
      void reloadHistory()
      return
    }
    append(h, s)
    useMonitor.setState((st) => ({ version: st.version + 1 }))
  })
  // Le hello d'un autre démarrage de llama-webui précède toujours ses snapshots : l'historique local ne vaut plus rien.
  let bootId: string | null = null
  onWs("hello", ({ payload }) => {
    if (bootId !== null && bootId !== payload.bootId) useMonitor.setState({ history: emptyHistory(), snapshot: null })
    bootId = payload.bootId
  })
  useWs.subscribe((s, prev) => {
    if (s.status === "open" && prev.status !== "open") void reloadHistory()
  })
}
