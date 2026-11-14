import type { BenchMeasure, BenchDevice as LlamaBenchDevice } from 'llamacpp-js/bench';
import { z } from 'zod';
import { reservedFlag, reservedFlagMessage } from './profile.ts';
import type { FitVerdict } from './tuning.ts';

export const CACHE_TYPES = ['f32', 'f16', 'bf16', 'f8_e4m3', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;
export type CacheType = (typeof CACHE_TYPES)[number];
export const SPLIT_MODES = ['none', 'layer', 'row', 'tensor'] as const;
export const FLASH_ATTN = ['on', 'off', 'auto'] as const;

const int = (min: number, max = 1_000_000) =>
  z
    .number({ error: 'expected a number' })
    .int({ error: 'expected an integer' })
    .min(min, `at least ${min}`)
    .max(max, `at most ${max}`);

/** The spec's flags, in a form shared by both tools. Missing key = the tool's default. */
export const BenchParamsSchema = z.strictObject({
  ngl: z.union([int(0, 9999), z.literal('all'), z.literal('auto')], { error: 'a number, “all” or “auto”' }).optional(),
  ot: z.array(z.string().regex(/^[^=,;]+=[^=,;]+$/, 'expected pattern=buffer (e.g. exps=CPU)')).optional(),
  ncmoe: int(0, 9999).optional(),
  dev: z.array(z.string().regex(/^[A-Za-z]+\d*$/, 'expected a device name (e.g. CUDA0)')).optional(),
  ts: z.array(z.number({ error: 'expected a number' }).min(0, 'expected a positive proportion')).optional(),
  sm: z.enum(SPLIT_MODES, { error: 'none, layer, row or tensor' }).optional(),
  fa: z.enum(FLASH_ATTN, { error: 'on, off or auto' }).optional(),
  ctk: z.enum(CACHE_TYPES, { error: 'unknown cache type' }).optional(),
  ctv: z.enum(CACHE_TYPES, { error: 'unknown cache type' }).optional(),
  t: int(1, 1024).optional(),
  b: int(1).optional(),
  ub: int(1).optional(),
});
export type BenchParams = z.infer<typeof BenchParamsSchema>;
type Key = keyof BenchParams;

/** Fixed field order, with each field's short flag and its llama-server long forms. */
const FIELDS: { key: Key; short: string; long: string[] }[] = [
  { key: 'ngl', short: '-ngl', long: ['--gpu-layers', '--n-gpu-layers'] },
  { key: 'ot', short: '-ot', long: ['--override-tensor'] },
  { key: 'ncmoe', short: '-ncmoe', long: ['--n-cpu-moe'] },
  { key: 'dev', short: '-dev', long: ['--device'] },
  { key: 'ts', short: '-ts', long: ['--tensor-split'] },
  { key: 'sm', short: '-sm', long: ['--split-mode'] },
  { key: 'fa', short: '-fa', long: ['--flash-attn'] },
  { key: 'ctk', short: '-ctk', long: ['--cache-type-k'] },
  { key: 'ctv', short: '-ctv', long: ['--cache-type-v'] },
  { key: 't', short: '-t', long: ['--threads'] },
  { key: 'b', short: '-b', long: ['--batch-size'] },
  { key: 'ub', short: '-ub', long: ['--ubatch-size'] },
];
/** Fixed field order (translation, cartesian product of a sweep, labels). */
export const FIELD_ORDER: readonly Key[] = FIELDS.map((f) => f.key);
const BY_FLAG = new Map(FIELDS.flatMap((f) => [f.short, ...f.long].map((flag) => [flag, f] as const)));

export type BenchKind = 'bench' | 'server';
/** Prefix of the error recorded for a run that ran out of memory. */
export const OOM_ERROR = 'Out of memory';
/** Prefixes written by earlier versions, still present in existing databases. */
const LEGACY_OOM_ERRORS: readonly string[] = ['Mémoire insuffisante'];
/** True when a run's error is an out-of-memory failure (current or legacy wording). */
export const isOomError = (error: string | null | undefined): boolean =>
  !!error && (error.startsWith(OOM_ERROR) || LEGACY_OOM_ERRORS.some((p) => error.startsWith(p)));

/** `queued`: a sweep item waiting its turn. */
export type BenchStatus = 'queued' | 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted';

/** “Other server flags”: rejects reserved flags and those covered by a field, at the offending index. */
export const serverArgsField = z
  .array(z.string())
  .default([])
  .superRefine((args, ctx) => {
    args.forEach((arg, i) => {
      const flag = arg.split('=')[0]!;
      const reserved = reservedFlag(arg);
      if (reserved) ctx.addIssue({ code: 'custom', path: [i], message: reservedFlagMessage(reserved) });
      else {
        const field = BY_FLAG.get(flag);
        if (field) ctx.addIssue({ code: 'custom', path: [i], message: `${flag}: use the ${field.short} field` });
      }
    });
  });

/** Fields shared by a run and a sweep. */
export const benchSpecBase = {
  modelPath: z
    .string({ error: 'required' })
    .refine((p) => p.startsWith('/'), 'expected an absolute path')
    .refine((p) => p.endsWith('.gguf'), 'expected a .gguf file'),
  mmprojPath: z.string().nullable().default(null),
  profileId: z.number().int().nullable().default(null),
  p: int(1, 32_768).default(512),
  n: int(1, 4096).default(128),
  r: int(1, 20).default(3),
};

export const BenchSpecSchema = z.strictObject({
  kind: z.enum(['bench', 'server'], { error: '“bench” or “server”' }),
  ...benchSpecBase,
  params: BenchParamsSchema.default({}),
  serverArgs: serverArgsField,
});
export type BenchSpec = z.infer<typeof BenchSpecSchema>;
export type BenchSpecInput = z.input<typeof BenchSpecSchema>;

/** A pp or tg measure of a run. */
export type Measure = BenchMeasure;

export interface BenchHardware {
  cpu: string;
  gpus: { name: string; busId: string; vramTotalBytes: number }[];
  build: string | null;
}

export interface BenchRun {
  id: number;
  kind: BenchKind;
  status: BenchStatus;
  spec: BenchSpec;
  command: string;
  hardware: BenchHardware;
  pp: Measure | null;
  tg: Measure | null;
  draftAcceptPct: number | null;
  vramPeak: { key: string; name: string; mib: number }[];
  error: string | null;
  logExcerpt: string;
  durationMs: number | null;
  /** Peak read bandwidth of the model's disk during the run (bytes/s), if measured. */
  diskReadPeakBps: number | null;
  sweepId: number | null;
  /** Label of the item within its sweep (“-ncmoe 8 · -dev CUDA0,CUDA1”). */
  sweepLabel: string | null;
  /** The estimator's verdict at planning time. */
  fit: FitVerdict | null;
  createdAt: number;
}

export type BenchPhase =
  | 'stopping-server'
  | 'loading'
  | 'warmup'
  | 'prompt'
  | 'generation'
  | 'measure'
  | 'restarting-server';

export interface BenchLive {
  runId: number;
  kind: BenchKind;
  phase: BenchPhase;
  step: { index: number; total: number } | null;
  startedAt: number;
  /** The tool's last 20 lines. */
  lines: string[];
}

/** A device of `llama-bench --list-devices`, with what the monitor knows of it. */
export interface BenchDevice extends LlamaBenchDevice {
  /**
   * VRAM used by other processes than the managed llama-server (desktop, another model), from the monitor; the
   * estimator deducts it from the budget. Missing: unknown (card not matched to the monitor, or not read).
   */
  otherUsedMib?: number;
}

/** Parsed value for a field, or undefined if unreadable (the flag then stays in `rest`). */
function readValue(key: Key, raw: string): BenchParams[Key] | undefined {
  const num = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined);
  const intOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);
  const list = (s: string) => s.split(',').filter((x) => x !== '');
  switch (key) {
    case 'ngl':
      return raw === 'all' || raw === 'auto' ? raw : intOf(raw);
    case 'ot':
      return list(raw);
    case 'dev':
      return list(raw);
    case 'ts': {
      const parts = list(raw).map(num);
      return parts.length > 0 && parts.every((x) => x !== undefined) ? (parts as number[]) : undefined;
    }
    case 'sm':
      return (SPLIT_MODES as readonly string[]).includes(raw) ? (raw as BenchParams['sm']) : undefined;
    case 'fa':
      return (FLASH_ATTN as readonly string[]).includes(raw) ? (raw as BenchParams['fa']) : undefined;
    case 'ctk':
    case 'ctv':
      return (CACHE_TYPES as readonly string[]).includes(raw) ? (raw as BenchParams['ctk']) : undefined;
    default:
      return intOf(raw);
  }
}

/** Splits a llama-server profile's args: flags covered by a field, and the rest in their original order. */
export function paramsFromServerArgs(args: string[]): { params: BenchParams; rest: string[] } {
  const params: BenchParams = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('-') && eq > 0 ? arg.slice(0, eq) : arg;
    const field = BY_FLAG.get(flag);
    if (!field) {
      rest.push(arg);
      continue;
    }
    let raw: string | undefined;
    const taken: string[] = [arg];
    if (eq > 0 && flag !== arg) raw = arg.slice(eq + 1);
    else if (field.key === 'fa') {
      // -fa without a value (old form) = on.
      const next = args[i + 1];
      if (next !== undefined && (FLASH_ATTN as readonly string[]).includes(next)) {
        raw = next;
        taken.push(next);
        i++;
      } else raw = 'on';
    } else if (i + 1 < args.length) {
      raw = args[++i]!;
      taken.push(raw);
    }
    const value = raw === undefined ? undefined : readValue(field.key, raw);
    if (value === undefined) {
      rest.push(...taken);
      continue;
    }
    if (field.key === 'ot') params.ot = [...(params.ot ?? []), ...(value as string[])];
    else (params as Record<string, unknown>)[field.key] = value;
  }
  return { params, rest };
}

/** The context size set by a profile's args (`-c`, `--ctx-size`, `=` form); undefined when absent or invalid. */
export function ctxFromArgs(args: string[]): number | undefined {
  let out: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let raw: string | undefined;
    if (arg === '-c' || arg === '--ctx-size') raw = args[++i];
    else if (arg.startsWith('--ctx-size=') || arg.startsWith('-c=')) raw = arg.slice(arg.indexOf('=') + 1);
    if (raw === undefined) continue;
    const n = Number(raw);
    out = Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return out;
}

/** `args` with `-c <ctx>` appended when they set no context: llama-server would otherwise allocate the model's full one. */
export function withCtx(args: string[], ctx: number | null | undefined): string[] {
  return ctx && ctxFromArgs(args) === undefined ? [...args, '-c', String(ctx)] : args;
}

function toArgs(p: BenchParams, tool: BenchKind): string[] {
  const out: string[] = [];
  const sep = tool === 'bench' ? '/' : ',';
  for (const { key, short } of FIELDS) {
    const v = p[key];
    if (v === undefined) continue;
    if (key === 'ngl' && v === 'auto') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    let s: string;
    if (key === 'ngl') s = v === 'all' ? (tool === 'bench' ? '999' : 'all') : String(v);
    else if (key === 'ot') s = (v as string[]).join(tool === 'bench' ? ';' : ',');
    else if (Array.isArray(v)) s = v.map(String).join(sep);
    else s = String(v);
    out.push(short, s);
  }
  return out;
}

/** The fields as llama-server flags (`,` between values). */
export const serverArgs = (p: BenchParams): string[] => toArgs(p, 'server');
/** The fields as llama-bench flags (`/` for -dev and -ts, `;` for -ot). */
export const benchArgs = (p: BenchParams): string[] => toArgs(p, 'bench');

const IGNORED: { test: (flag: string) => boolean; why: string }[] = [
  { test: (f) => f === '-c' || f === '--ctx-size', why: 'context not allocated' },
  {
    // Every speculative flag: --spec-type, --spec-draft-n-max, --spec-default…, the draft model and its placement (#30).
    test: (f) =>
      f.startsWith('--spec-') ||
      f === '-md' ||
      f.startsWith('--model-draft') ||
      f.startsWith('--draft') ||
      f === '-ngld' ||
      f === '--gpu-layers-draft' ||
      f === '--n-gpu-layers-draft' ||
      f === '-devd' ||
      f === '--device-draft' ||
      f === '-cd' ||
      f === '--ctx-size-draft',
    why: 'speculative decoding not measured',
  },
  { test: (f) => f === '-cmoe' || f === '--cpu-moe', why: 'use -ncmoe' },
  { test: (f) => f === '-np' || f === '--parallel', why: 'parallel slots' },
];

/** Profile flags that change speed or memory and that llama-bench does not reproduce. */
export function ignoredByBench(rest: string[]): { flag: string; why: string }[] {
  const out: { flag: string; why: string }[] = [];
  for (const arg of rest) {
    if (!arg.startsWith('-')) continue;
    const flag = arg.split('=')[0]!;
    const hit = IGNORED.find((i) => i.test(flag));
    if (hit) out.push({ flag, why: hit.why });
  }
  return out;
}
