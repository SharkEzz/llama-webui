import { type BenchRun, benchArgs, type Measure, serverArgs, shellQuote } from "@llama-webui/shared"
import { formatRate } from "@/lib/format"

/** Nom du fichier sans dossier ni `.gguf`. */
export const modelName = (path: string) => (path.split("/").pop() ?? path).replace(/\.gguf$/, "")

/** Les flags du run dans la syntaxe de son outil (plus les autres flags pour un run serveur). */
export function flagsOf(run: BenchRun): string {
  const s = run.spec
  const args = s.kind === "bench" ? benchArgs(s.params) : [...serverArgs(s.params), ...s.serverArgs]
  return args.length > 0 ? shellQuote(args) : "défauts"
}

/** « 51,2 tok/s ± 0,4 ». */
export function formatMeasure(m: Measure | null): string {
  if (!m) return "—"
  const sd = m.stddev > 0 ? ` ± ${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(m.stddev)}` : ""
  return `${formatRate(m.tps)}${sd}`
}

/** Somme des pics de VRAM, en Gio. */
export function vramTotal(run: BenchRun): string {
  const mib = run.vramPeak.reduce((a, v) => a + v.mib, 0)
  return mib === 0 ? "—" : formatMib(mib)
}

/** « 985 Mio » sous 1 Gio, sinon « 17,52 Gio ». */
export const formatMib = (mib: number) =>
  mib < 1024
    ? `${Math.round(mib)} Mio`
    : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(mib / 1024)} Gio`

export const dateFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

/** Taux d'acceptation des drafts (« 47,5 % »), « — » sans décodage spéculatif. */
export const formatAccept = (pct: number | null) =>
  pct === null ? "—" : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(pct)} %`
