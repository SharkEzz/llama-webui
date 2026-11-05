export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogKind = "srv" | "slot" | "other";

export interface LogLine {
  seq: number;
  text: string;
  level: LogLevel;
  kind: LogKind;
}

export const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

// llama.cpp format: "<m.ss.mmm.uuu> <L> <tag> <func>: message"
const PREFIX = /^\d+\.\d+(?:\.\d+)*\s+([IWEDT])\s+(.*)$/;
const LEVEL_CHAR: Record<string, LogLevel> = { E: "error", W: "warn", I: "info", D: "debug", T: "debug" };

export function classifyLine(text: string): { level: LogLevel; kind: LogKind } {
  const m = PREFIX.exec(text);
  let level: LogLevel;
  let body = text;
  if (m) {
    level = LEVEL_CHAR[m[1]!]!;
    body = m[2]!;
  } else if (/\b(error|failed|abort)\b/i.test(text)) level = "error";
  else if (/\bwarn(ing)?\b/i.test(text)) level = "warn";
  else level = "info";
  const kind: LogKind = /^srv\s/.test(body) ? "srv" : /^slot\s/.test(body) ? "slot" : "other";
  return { level, kind };
}

export function filterLogs(lines: readonly LogLine[], opts: { minLevel: LogLevel; query: string }): LogLine[] {
  const min = LEVEL_ORDER.indexOf(opts.minLevel);
  const q = opts.query.toLowerCase();
  return lines.filter((l) => LEVEL_ORDER.indexOf(l.level) >= min && (q === "" || l.text.toLowerCase().includes(q)));
}
