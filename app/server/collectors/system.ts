import type { MemInfo, SystemSample } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Option, Order, Path, Ref, String as Str } from 'effect';
import { dual, pipe } from 'effect/Function';
import { readText } from './read.ts';

export interface CpuTimes {
  readonly busy: number;
  readonly total: number;
}

interface Times {
  readonly total: CpuTimes;
  readonly cores: ReadonlyArray<CpuTimes>;
}

const numbers = (text: string): ReadonlyArray<number> => pipe(text, Str.trim, Str.split(/\s+/), Arr.map(Number));

/** `/proc/stat` cpu lines: user nice system idle iowait irq softirq steal (guest is already in user). */
export const parseProcStat = (text: string): Times | null => {
  let total: CpuTimes | null = null;
  const cores: Array<CpuTimes> = [];
  for (const line of Str.split(text, '\n')) {
    const m = /^cpu(\d*)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const f = Arr.take(numbers(m[2] ?? ''), 8);
    if (f.length < 4 || Arr.some(f, (n) => !Number.isFinite(n))) continue;
    const sum = Arr.reduce(f, 0, (a, b) => a + b);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    const t = { busy: sum - idle, total: sum };
    if (m[1] === '') total = t;
    else cores[Number(m[1])] = t;
  }
  return total === null ? null : { total, cores: Arr.filter(cores, (c) => c !== undefined) };
};

export const cpuPct: {
  (cur: CpuTimes): (prev: CpuTimes) => number;
  (prev: CpuTimes, cur: CpuTimes): number;
} = dual(2, (prev: CpuTimes, cur: CpuTimes): number => {
  const dt = cur.total - prev.total;
  return dt <= 0 ? 0 : Math.min(100, Math.max(0, (100 * (cur.busy - prev.busy)) / dt));
});

export const parseMeminfo = (text: string): MemInfo | null => {
  const kv = new Map<string, number>();
  for (const line of Str.split(text, '\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m !== null) kv.set(m[1] ?? '', Number(m[2]) * 1024);
  }
  const total = kv.get('MemTotal');
  if (total === undefined) return null;
  const swapTotal = kv.get('SwapTotal') ?? 0;
  return {
    totalBytes: total,
    availableBytes: kv.get('MemAvailable') ?? kv.get('MemFree') ?? 0,
    cachedBytes: kv.get('Cached') ?? 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - (kv.get('SwapFree') ?? swapTotal)),
  };
};

export const parseLoadavg = (text: string): readonly [number, number, number] | null => {
  const [a, b, c] = numbers(text);
  return a !== undefined && b !== undefined && c !== undefined && Arr.every([a, b, c], Number.isFinite)
    ? [a, b, c]
    : null;
};

const CPU_SENSORS = ['k10temp', 'coretemp'];

/** Machine-wide CPU, memory, load, frequency and CPU temperature: each read that fails is a null field. */
export const makeSystemSampler = Effect.fn('SystemSampler.make')(function* (
  options: { readonly procRoot?: string; readonly sysRoot?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const procRoot = options.procRoot ?? '/proc';
  const sysRoot = options.sysRoot ?? '/sys';
  const prev = yield* Ref.make(Option.none<Times>());

  /** The `temp1_input` of the first CPU hwmon sensor, none when the machine has no such sensor. */
  const findTempPath = Effect.gen(function* () {
    const dir = path.join(sysRoot, 'class/hwmon');
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const sorted = Arr.sort(
      entries,
      Order.make<string>((a, b) => Str.localeCompare(b, undefined, { numeric: true })(a)),
    );
    return yield* Effect.findFirst(sorted, (e) =>
      readText(path.join(dir, e, 'name')).pipe(Effect.map((name) => CPU_SENSORS.includes(Str.trim(name ?? '')))),
    ).pipe(Effect.map(Option.map((e) => path.join(dir, e, 'temp1_input'))));
  });
  const tempPath = yield* Effect.cached(findTempPath);

  const freqMhz = (cores: number) =>
    Effect.forEach(
      Arr.makeBy(cores, (i) => i),
      (i) => readText(path.join(sysRoot, 'devices/system/cpu', `cpu${i}`, 'cpufreq/scaling_cur_freq')),
      { concurrency: 'unbounded' },
    ).pipe(
      Effect.map((vals) => {
        const khz = pipe(
          vals,
          Arr.map((v) => Number(Str.trim(v ?? ''))),
          Arr.filter((n) => Number.isFinite(n) && n > 0),
        );
        return khz.length === 0 ? null : Math.round(Arr.reduce(khz, 0, (a, b) => a + b) / khz.length / 1000);
      }),
    );

  const sample = Effect.fn('SystemSampler.sample')(function* () {
    const temp = yield* tempPath;
    const [statText, memText, loadText, tempText] = yield* Effect.all(
      [
        readText(path.join(procRoot, 'stat')),
        readText(path.join(procRoot, 'meminfo')),
        readText(path.join(procRoot, 'loadavg')),
        Option.match(temp, { onNone: () => Effect.succeed(null), onSome: readText }),
      ],
      { concurrency: 4 },
    );
    const cur = statText === null ? null : parseProcStat(statText);
    const before = cur === null ? Option.none<Times>() : yield* Ref.getAndSet(prev, Option.some(cur));
    const milli = Number(Str.trim(tempText ?? ''));
    return {
      cpuPct: cur === null ? 0 : Option.match(before, { onNone: () => 0, onSome: (p) => cpuPct(p.total, cur.total) }),
      corePct: Arr.map(cur?.cores ?? [], (c, i) =>
        Option.match(
          Option.flatMapNullishOr(before, (p) => p.cores[i]),
          {
            onNone: () => 0,
            onSome: (p) => cpuPct(p, c),
          },
        ),
      ),
      freqMhz: yield* freqMhz(cur?.cores.length ?? 0),
      tempC: tempText !== null && Number.isFinite(milli) ? milli / 1000 : null,
      load: loadText === null ? null : parseLoadavg(loadText),
      mem: memText === null ? null : parseMeminfo(memText),
    } satisfies SystemSample;
  });

  return { sample: sample() } as const;
});
