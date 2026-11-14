import {
  type BenchParams,
  CACHE_TYPES,
  type Estimate,
  type Profile,
  presetOf,
  profileModelPath,
} from '@llama-webui/shared';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { EMPTY_FORM, formFromSpec, useBench } from '@/lib/bench';
import { useModels } from '@/lib/models';
import { createProfile, useProfiles } from '@/lib/profiles';
import { stem } from '@/lib/stem';
import { useTuning } from '@/lib/tuning';

/** The profile's other flags minus those the estimate already sets (-c, --fit, --mlock, --numa…), values included. */
export function mergeArgs(estimateArgs: string[], rest: string[]): string[] {
  const fixed = new Set(estimateArgs.filter((a) => a.startsWith('-')));
  if (fixed.has('-c')) fixed.add('--ctx-size');
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const flag = a.split('=')[0]!;
    if (!fixed.has(flag)) {
      out.push(a);
      continue;
    }
    const next = rest[i + 1];
    if (!a.includes('=') && next !== undefined && !/^--?[a-z]/i.test(next)) i++;
  }
  return [...estimateArgs, ...out];
}

/** Profile built from the estimate (the estimate's flags + the source profile's other flags and its environment). */
export async function profileFromEstimate(e: Estimate): Promise<Profile | null> {
  const { modelPath, mmprojPath, profileId, serverArgs } = useTuning.getState();
  const list = useModels.getState().list;
  if (!modelPath) return null;
  const opts = { modelsDir: list?.setting ?? '~/models', home: list?.home ?? '' };
  const placed = profileModelPath(modelPath, opts);
  const mmproj = mmprojPath ? profileModelPath(mmprojPath, { ...opts, cwd: placed.cwd }).model : undefined;
  const origin = profileId !== null ? useProfiles.getState().profiles.find((p) => p.id === profileId) : undefined;
  const base = `${stem(modelPath)} — ${presetOf(e.preset).label}`;
  for (let n = 1; n < 50; n++) {
    try {
      const p = await createProfile({
        name: n === 1 ? base : `${base} (${n})`,
        model: placed.model,
        ...(mmproj ? { mmproj } : {}),
        ...(placed.cwd ? { cwd: placed.cwd } : {}),
        args: mergeArgs(e.serverArgs, serverArgs),
        env: origin?.env ?? {},
      });
      toast.success(`Profile “${p.name}” created`);
      void useProfiles.getState().reload();
      return p;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'name-taken') continue;
      toast.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return null;
}

/** Prefills the Benchmark form with the estimate (llama-bench; “Server” keeps the -c and the other flags). */
export function benchFromEstimate(e: Estimate): void {
  const { modelPath, mmprojPath, profileId, serverArgs } = useTuning.getState();
  if (!modelPath) return;
  const rest = mergeArgs(['-c', String(e.ctx)], serverArgs);
  useBench.setState({
    form: formFromSpec({ modelPath, mmprojPath, profileId, params: e.params, serverArgs: rest }, EMPTY_FORM),
    errors: {},
  });
}

export type PinKey = 'ngl' | 'ncmoe' | 'dev' | 'ts' | 'kv' | 't' | 'ub';

/** Value typed to pin a flag → BenchParams patch, or an error message. */
export function parsePin(key: PinKey, text: string): Partial<BenchParams> | string {
  const t = text.trim();
  const int = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
  switch (key) {
    case 'ngl': {
      if (t === 'all') return { ngl: 'all' };
      const n = int(t);
      return n === null ? 'a number of layers or “all”' : { ngl: n };
    }
    case 'ncmoe':
    case 't':
    case 'ub': {
      const n = int(t);
      return n === null || (key !== 'ncmoe' && n === 0) ? 'an integer' : { [key]: n };
    }
    case 'dev': {
      const ids = t.split(/[\s,/]+/).filter(Boolean);
      return ids.length === 0 ? 'at least one device (CUDA0,Vulkan3)' : { dev: ids };
    }
    case 'ts': {
      const xs = t
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return xs.length < 2 || xs.some((x) => !Number.isFinite(x) || x < 0) ? 'proportions (3,1)' : { ts: xs };
    }
    case 'kv':
      return (CACHE_TYPES as readonly string[]).includes(t)
        ? { ctk: t as BenchParams['ctk'], ctv: t as BenchParams['ctv'] }
        : `one of ${CACHE_TYPES.join(', ')}`;
  }
}

/** Pinnable flag of a recommendation row. */
export const PIN_OF_ROW: Record<string, PinKey> = {
  '-ngl': 'ngl',
  '-ncmoe': 'ncmoe',
  '-dev': 'dev',
  '-ts': 'ts',
  '-ctk / -ctv': 'kv',
  '-t': 't',
  '-b / -ub': 'ub',
};

export const PIN_LABEL: Record<keyof BenchParams, string> = {
  ngl: '-ngl',
  ncmoe: '-ncmoe',
  dev: '-dev',
  ts: '-ts',
  ot: '-ot',
  sm: '-sm',
  fa: '-fa',
  ctk: '-ctk',
  ctv: '-ctv',
  t: '-t',
  b: '-b',
  ub: '-ub',
};

export const pinValue = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v));
