import { Array as Arr, Option, Order, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';

export const LogLevel = Schema.Literals(['error', 'warn', 'info', 'debug']);
export type LogLevel = typeof LogLevel.Type;

export const LogKind = Schema.Literals(['srv', 'slot', 'other']);
export type LogKind = typeof LogKind.Type;

/** A line of llama-server's log, numbered from 0 on each boot of llama-webui. */
export const LogLine = Schema.Struct({ seq: Schema.Int, text: Schema.String, level: LogLevel, kind: LogKind });
export type LogLine = typeof LogLine.Type;

/** Log line written by llama-webui before each llama-server launch; the model placement is read from the next lines. */
export const LAUNCH_LOG_PREFIX = '[llama-webui] launch:';

/**
 * Log line written by llama-webui after the launch line when the server's environment sets `GGML_CUDA_P2P`: llama.cpp
 * then enables direct transfers between the GPUs whose driver allows it, and logs nothing about it.
 */
export const P2P_LOG_LINE = '[llama-webui] GGML_CUDA_P2P is set: direct transfers between GPUs requested';

export const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// llama.cpp format: "<m.ss.mmm.uuu> <L> <tag> <func>: message"
const PREFIX = /^\d+\.\d+(?:\.\d+)*\s+([IWEDT])\s+(.*)$/;
const levelOfChar = (char: string): LogLevel =>
  char === 'E' ? 'error' : char === 'W' ? 'warn' : char === 'I' ? 'info' : 'debug';

/** The level of a line without llama.cpp's prefix: read from its words. */
const levelOfWords = (text: string): LogLevel =>
  /\b(error|failed|abort)\b/i.test(text) ? 'error' : /\bwarn(ing)?\b/i.test(text) ? 'warn' : 'info';

const kindOf = (body: string): LogKind => (/^srv\s/.test(body) ? 'srv' : /^slot\s/.test(body) ? 'slot' : 'other');

export function classifyLine(text: string): { level: LogLevel; kind: LogKind } {
  return Option.fromNullishOr(PREFIX.exec(text)).pipe(
    Option.match({
      onNone: () => ({ level: levelOfWords(text), kind: kindOf(text) }),
      onSome: (match) => ({ level: levelOfChar(match[1] ?? ''), kind: kindOf(match[2] ?? '') }),
    }),
  );
}

const rank = (level: LogLevel): number =>
  Arr.findFirstIndex(LEVEL_ORDER, (l) => l === level).pipe(Option.getOrElse(() => -1));

export const filterLogs: {
  (opts: { minLevel: LogLevel; query: string }): (lines: readonly LogLine[]) => LogLine[];
  (lines: readonly LogLine[], opts: { minLevel: LogLevel; query: string }): LogLine[];
} = dual(2, (lines: readonly LogLine[], opts: { minLevel: LogLevel; query: string }): LogLine[] => {
  const min = rank(opts.minLevel);
  const q = Str.toLowerCase(opts.query);
  return Arr.filter(lines, (l) => rank(l.level) >= min && (Str.isEmpty(q) || Str.includes(q)(Str.toLowerCase(l.text))));
});

/** Logs held by the client, tied to one llama-webui boot (numbering restarts from 0 on every boot). */
export interface LogView {
  lines: LogLine[];
  /** Number of the next expected line. */
  seq: number;
  /** Server boot the lines come from (null before the first hello). */
  bootId: string | null;
  /** “Clear view”: lines with a lower number are hidden (-1: none). */
  hiddenBefore: number;
}

export const EMPTY_LOG_VIEW: LogView = { lines: [], seq: 0, bootId: null, hiddenBefore: -1 };

/** New server boot: the previous boot's lines and hiding no longer mean anything. */
export const onBoot: {
  (bootId: string): (view: LogView) => LogView;
  (view: LogView, bootId: string): LogView;
} = dual(2, (view: LogView, bootId: string): LogView => {
  if (view.bootId === bootId) return view;
  if (view.bootId === null) return { ...view, bootId };
  return { lines: [], seq: 0, bootId, hiddenBefore: -1 };
});

const lastSeq = (lines: readonly LogLine[]): number =>
  Arr.last(lines).pipe(
    Option.map((l) => l.seq),
    Option.getOrElse(() => -1),
  );

const bySeq = Order.mapInput(Order.Number, (l: LogLine) => l.seq);

/** Merges by number (deduplicated, sorted) and keeps the last `max` lines. */
export const mergeLogs: {
  (incoming: LogLine[], max: number): (view: LogView) => LogView;
  (view: LogView, incoming: LogLine[], max: number): LogView;
} = dual(
  3,
  (view: LogView, incoming: LogLine[], max: number): LogView =>
    Arr.match(incoming, {
      onEmpty: () => view,
      onNonEmpty: (batch) => {
        const merged =
          Arr.headNonEmpty(batch).seq > lastSeq(view.lines)
            ? Arr.appendAll(view.lines, batch)
            : Arr.sort(
                // The incoming copy of a line wins over the one held.
                Arr.dedupeWith(Arr.appendAll(batch, view.lines), (a, b) => a.seq === b.seq),
                bySeq,
              );
        const lines = merged.length > max ? Arr.takeRight(merged, max) : merged;
        return { ...view, lines, seq: Math.max(view.seq, lastSeq(lines) + 1) };
      },
    }),
);
