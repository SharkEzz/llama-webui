import { create } from "zustand"
import type { LogLine } from "@llama-webui/shared"
import { api } from "./api"
import { onWs, useWs } from "./ws"

const MAX_LINES = 10_000

interface LogsStore {
  lines: LogLine[]
  /** Numéro de la prochaine ligne attendue. */
  seq: number
}

export const useLogs = create<LogsStore>()(() => ({ lines: [], seq: 0 }))

/** Fusionne par numéro (dédoublonné, trié), garde les 10 000 dernières. */
function merge(current: LogLine[], incoming: LogLine[]): LogLine[] {
  if (incoming.length === 0) return current
  const last = current.at(-1)?.seq ?? -1
  let lines: LogLine[]
  if (incoming[0]!.seq > last) lines = current.concat(incoming)
  else {
    const bySeq = new Map<number, LogLine>()
    for (const l of current) bySeq.set(l.seq, l)
    for (const l of incoming) bySeq.set(l.seq, l)
    lines = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
}

function append(incoming: LogLine[]) {
  useLogs.setState((s) => {
    const lines = merge(s.lines, incoming)
    return { lines, seq: Math.max(s.seq, (lines.at(-1)?.seq ?? -1) + 1) }
  })
}

async function replay() {
  const { seq } = useLogs.getState()
  try {
    const r = await api<{ lines: LogLine[]; seq: number }>(`/logs?since=${seq}`)
    if (r.seq < seq) {
      // llama-webui a redémarré : sa numérotation repart de zéro
      const all = await api<{ lines: LogLine[]; seq: number }>("/logs?since=0")
      useLogs.setState({ lines: all.lines, seq: all.seq })
    } else append(r.lines)
  } catch {
    // réessayé à la prochaine reconnexion
  }
}

let started = false
export function startLogsSync() {
  if (started) return
  started = true
  onWs("log", (m) => append(m.payload))
  useWs.subscribe((s, prev) => {
    if (s.status === "open" && prev.status !== "open") void replay()
  })
}
