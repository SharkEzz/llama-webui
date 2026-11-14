import { Clock, Effect, Option, Path, Ref, String as Str } from 'effect';
import { pipe } from 'effect/Function';
import { readText } from './read.ts';

const CLK_TCK = 100;

/** `/proc/<pid>/stat`: utime and stime (fields 14 and 15), after the command name, which may hold spaces. */
export const parseStat = (text: string): { readonly utime: number; readonly stime: number } | null => {
  const close = Str.lastIndexOf(')')(text);
  if (Option.isNone(close)) return null;
  const rest = pipe(text, Str.slice(close.value + 2), Str.split(' '));
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? { utime, stime } : null;
};

/** `/proc/<pid>/status`: VmRSS in bytes. */
export const parseRss = (status: string): number | null => {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
  return m === null ? null : Number(m[1]) * 1024;
};

interface Previous {
  readonly pid: number;
  readonly ticks: number;
  readonly at: number;
}

/** CPU % (of one core) and resident memory of a process, against the previous sample of the same pid. */
export const makeProcSampler = Effect.fn('ProcSampler.make')(function* (options: { readonly procRoot?: string } = {}) {
  const path = yield* Path.Path;
  const procRoot = options.procRoot ?? '/proc';
  const prev = yield* Ref.make(Option.none<Previous>());
  const forget = (pid: number) =>
    Ref.update(
      prev,
      Option.filter((p) => p.pid !== pid),
    );

  const sample = Effect.fn('ProcSampler.sample')(function* (pid: number) {
    const dir = path.join(procRoot, String(pid));
    const [statText, statusText] = yield* Effect.all(
      [readText(path.join(dir, 'stat')), readText(path.join(dir, 'status'))],
      {
        concurrency: 2,
      },
    );
    const st = statText === null ? null : parseStat(statText);
    const rss = statusText === null ? null : parseRss(statusText);
    if (st === null || rss === null) {
      yield* forget(pid);
      return Option.none<{ cpuPct: number; rssBytes: number }>();
    }
    const ticks = st.utime + st.stime;
    const at = yield* Clock.currentTimeMillis;
    const before = yield* Ref.getAndSet(prev, Option.some({ pid, ticks, at }));
    const cpuPct = Option.match(before, {
      onNone: () => 0,
      onSome: (p) => (p.pid === pid && at > p.at ? ((ticks - p.ticks) / CLK_TCK / ((at - p.at) / 1000)) * 100 : 0),
    });
    return Option.some({ cpuPct: Math.max(0, cpuPct), rssBytes: rss });
  });

  return { sample } as const;
});
