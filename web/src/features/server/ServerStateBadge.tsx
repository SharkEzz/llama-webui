import type { ServerState } from "@llama-webui/shared"
import { cn } from "@/lib/utils"

const UI: Record<ServerState["kind"], { label: string; dot: string; text: string }> = {
  idle: { label: "Arrêté", dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  starting: { label: "Démarrage…", dot: "bg-tone-amber animate-pulse", text: "text-tone-amber" },
  ready: { label: "Prêt", dot: "bg-success shadow-[0_0_10px] shadow-success/60", text: "text-success" },
  stopping: { label: "Arrêt…", dot: "bg-tone-amber animate-pulse", text: "text-tone-amber" },
  crashed: { label: "Planté", dot: "bg-destructive", text: "text-destructive" },
  external: { label: "Externe", dot: "bg-tone-cyan", text: "text-tone-cyan" },
}

/** Détail d'un arrêt anormal, pour l'infobulle. */
export function crashDetail(s: ServerState): string | undefined {
  if (s.kind !== "crashed") return undefined
  const parts = [s.message, s.exitCode !== null ? `code ${s.exitCode}` : null, s.signal ? `signal ${s.signal}` : null]
  return parts.filter(Boolean).join(", ") || undefined
}

export function ServerStateBadge({ state, className }: { state: ServerState; className?: string }) {
  const ui = UI[state.kind]
  const extra = state.kind === "external" ? (state.pid !== null ? ` (PID ${state.pid})` : "") : ""
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-sm font-medium", ui.text, className)}
      title={crashDetail(state)}
    >
      <span className={cn("size-2 shrink-0 rounded-full", ui.dot)} aria-hidden="true" />
      {ui.label}
      {extra && <span className="num text-xs opacity-80">{extra}</span>}
    </span>
  )
}
