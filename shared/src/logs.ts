export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogKind = 'srv' | 'slot' | 'other';

export interface LogLine {
  seq: number;
  text: string;
  level: LogLevel;
  kind: LogKind;
}

export const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// llama.cpp format: "<m.ss.mmm.uuu> <L> <tag> <func>: message"
const PREFIX = /^\d+\.\d+(?:\.\d+)*\s+([IWEDT])\s+(.*)$/;
const LEVEL_CHAR: Record<string, LogLevel> = { E: 'error', W: 'warn', I: 'info', D: 'debug', T: 'debug' };

export function classifyLine(text: string): { level: LogLevel; kind: LogKind } {
  const m = PREFIX.exec(text);
  let level: LogLevel;
  let body = text;
  if (m) {
    level = LEVEL_CHAR[m[1]!]!;
    body = m[2]!;
  } else if (/\b(error|failed|abort)\b/i.test(text)) level = 'error';
  else if (/\bwarn(ing)?\b/i.test(text)) level = 'warn';
  else level = 'info';
  const kind: LogKind = /^srv\s/.test(body) ? 'srv' : /^slot\s/.test(body) ? 'slot' : 'other';
  return { level, kind };
}

export function filterLogs(lines: readonly LogLine[], opts: { minLevel: LogLevel; query: string }): LogLine[] {
  const min = LEVEL_ORDER.indexOf(opts.minLevel);
  const q = opts.query.toLowerCase();
  return lines.filter((l) => LEVEL_ORDER.indexOf(l.level) >= min && (q === '' || l.text.toLowerCase().includes(q)));
}

/** Logs tenus par le client, rattachés à un démarrage de llama-webui (la numérotation repart de 0 à chaque démarrage). */
export interface LogView {
  lines: LogLine[];
  /** Numéro de la prochaine ligne attendue. */
  seq: number;
  /** Démarrage du serveur dont viennent les lignes (null avant le premier hello). */
  bootId: string | null;
  /** « Vider l'affichage » : lignes de numéro inférieur masquées (-1 : rien). */
  hiddenBefore: number;
}

export const EMPTY_LOG_VIEW: LogView = { lines: [], seq: 0, bootId: null, hiddenBefore: -1 };

/** Nouveau démarrage du serveur : les lignes et le masquage de l'ancien n'ont plus de sens. */
export function onBoot(view: LogView, bootId: string): LogView {
  if (view.bootId === bootId) return view;
  if (view.bootId === null) return { ...view, bootId };
  return { lines: [], seq: 0, bootId, hiddenBefore: -1 };
}

/** Fusionne par numéro (dédoublonné, trié) et garde les `max` dernières lignes. */
export function mergeLogs(view: LogView, incoming: LogLine[], max: number): LogView {
  if (incoming.length === 0) return view;
  const last = view.lines.at(-1)?.seq ?? -1;
  let lines: LogLine[];
  if (incoming[0]!.seq > last) lines = view.lines.concat(incoming);
  else {
    const bySeq = new Map<number, LogLine>();
    for (const l of view.lines) bySeq.set(l.seq, l);
    for (const l of incoming) bySeq.set(l.seq, l);
    lines = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  if (lines.length > max) lines = lines.slice(lines.length - max);
  return { ...view, lines, seq: Math.max(view.seq, (lines.at(-1)?.seq ?? -1) + 1) };
}
