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
