/** Durée lisible : « 45 s », « 12 min 05 s », « 3 h 07 min », « 2 j 4 h ». */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  if (d > 0) return `${d} j ${h} h`
  if (h > 0) return `${h} h ${pad(m)} min`
  if (m > 0) return `${m} min ${pad(sec)} s`
  return `${sec} s`
}

const nf = (digits: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits })
const UNITS = ["o", "Ko", "Mo", "Go", "To"]

/** Octets : « 12,3 Go » (base 1024). */
export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—"
  let i = 0
  let v = Math.abs(n)
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${nf(i === 0 ? 0 : digits).format(Math.sign(n) * v)} ${UNITS[i]}`
}

/** Débit d'octets : « 1,2 Go/s ». */
export const formatBps = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${formatBytes(n)}/s`)

/** Débit de tokens : « 42,7 tok/s ». */
export const formatRate = (tps: number | null | undefined) => (tps == null || !Number.isFinite(tps) ? "—" : `${nf(1).format(tps)} tok/s`)

/** Pourcentage : « 37 % » (une décimale sous 10). */
export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${nf(Math.abs(n) < 10 && n !== 0 ? 1 : 0).format(n)} %`
}

/** Nombre entier groupé : « 32 768 ». */
export const formatInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : nf(0).format(n))
