import {
  type BenchDevice,
  type BenchKind,
  type BenchLive,
  type BenchParams,
  type BenchRun,
  type BenchSpec,
  type BenchStatus,
  defer,
  type Profile,
  shellQuote,
  shellSplit,
} from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { ApiError, api } from './api';
import { plural } from './format';
import { onWs, useWs } from './ws';

/** The form as typed: all text, converted on submit (the server validates and returns per-field errors). */
export interface BenchForm {
  kind: BenchKind;
  modelPath: string;
  mmprojPath: string;
  profileId: number | null;
  ngl: string;
  ncmoe: string;
  t: string;
  b: string;
  ub: string;
  dev: string[];
  /** Split per checked device. */
  ts: Record<string, string>;
  /** -ts without a checked device (“57,50”): splits in the tool's device order. */
  tsAll: string;
  sm: string;
  fa: string;
  ctk: string;
  ctv: string;
  /** One -ot rule per line. */
  ot: string;
  p: string;
  n: string;
  r: string;
  serverArgs: string;
}

export type FormField = keyof BenchForm;

export const EMPTY_FORM: BenchForm = {
  kind: 'bench',
  modelPath: '',
  mmprojPath: '',
  profileId: null,
  ngl: '',
  ncmoe: '',
  t: '',
  b: '',
  ub: '',
  dev: [],
  ts: {},
  tsAll: '',
  sm: '',
  fa: '',
  ctk: '',
  ctv: '',
  ot: '',
  p: '512',
  n: '128',
  r: '3',
  serverArgs: '',
};

const str = (v: number | string | undefined) => (v === undefined ? '' : String(v));

/** The fields of a BenchSpec (or of a draft derived from a profile). */
export function formFromSpec(
  s: Pick<BenchSpec, 'modelPath' | 'mmprojPath' | 'profileId' | 'params' | 'serverArgs'> &
    Partial<Pick<BenchSpec, 'kind' | 'p' | 'n' | 'r'>>,
  base: BenchForm = EMPTY_FORM,
): BenchForm {
  const p = s.params;
  const dev = p.dev ?? [];
  return {
    ...base,
    kind: s.kind ?? base.kind,
    modelPath: s.modelPath,
    mmprojPath: s.mmprojPath ?? '',
    profileId: s.profileId,
    ngl: str(p.ngl),
    ncmoe: str(p.ncmoe),
    t: str(p.t),
    b: str(p.b),
    ub: str(p.ub),
    dev,
    ts: Object.fromEntries(dev.map((d, i) => [d, str(p.ts?.[i])])),
    tsAll: dev.length === 0 ? (p.ts ?? []).join(',') : '',
    sm: p.sm ?? '',
    fa: p.fa ?? '',
    ctk: p.ctk ?? '',
    ctv: p.ctv ?? '',
    ot: (p.ot ?? []).join('\n'),
    p: s.p !== undefined ? String(s.p) : base.p,
    n: s.n !== undefined ? String(s.n) : base.n,
    r: s.r !== undefined ? String(s.r) : base.r,
    serverArgs: shellQuote(s.serverArgs),
  };
}

/** Flags from a textarea: line breaks separate like spaces. */
export const splitArgs = (text: string) => shellSplit(text.replace(/\r?\n/g, ' '));

/** Typed number (empty = absent; unparsable text is sent as is so the server explains). */
const num = (v: string): number | string | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
};

/** The `spec` body of POST /api/bench/run; unparsable `serverArgs` → local error. */
export function specFromForm(f: BenchForm): { spec: Record<string, unknown> } | { field: FormField; error: string } {
  const split = splitArgs(f.serverArgs);
  if (!Array.isArray(split)) return { field: 'serverArgs', error: split.error };
  const params: Record<string, unknown> = {};
  const set = (k: keyof BenchParams, v: unknown) => {
    if (v !== undefined && v !== '') params[k] = v;
  };
  const ngl = f.ngl.trim();
  set('ngl', ngl === 'all' || ngl === 'auto' ? ngl : num(ngl));
  set('ncmoe', num(f.ncmoe));
  set('t', num(f.t));
  set('b', num(f.b));
  set('ub', num(f.ub));
  if (f.dev.length > 0) {
    set('dev', f.dev);
    const ts = f.dev.map((d) => num(f.ts[d] ?? ''));
    if (ts.some((x) => x !== undefined))
      set(
        'ts',
        ts.map((x) => x ?? 0),
      );
  } else {
    const ts = f.tsAll.split(/[\s,/]+/).filter(Boolean);
    if (ts.length > 0)
      set(
        'ts',
        ts.map((x) => num(x)),
      );
  }
  set('sm', f.sm);
  set('fa', f.fa);
  set('ctk', f.ctk);
  set('ctv', f.ctv);
  const ot = f.ot
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (ot.length > 0) set('ot', ot);
  return {
    spec: {
      kind: f.kind,
      modelPath: f.modelPath.trim(),
      // Kept for llama-bench too (which ignores it): “Create profile” or “Restart” as a server need it.
      mmprojPath: f.mmprojPath.trim() || null,
      profileId: f.profileId,
      params,
      serverArgs: split,
      p: num(f.p),
      n: num(f.n),
      r: num(f.r),
    },
  };
}

/** Form field targeted by a zod error path of the spec (`["params", "ngl"]` → “ngl”, `["serverArgs", 2]` → “serverArgs”). */
function fieldOf(path: (string | number)[]): FormField {
  const [a, b] = path;
  if (a === 'params' && typeof b === 'string') return b as FormField;
  return (typeof a === 'string' ? a : 'modelPath') as FormField;
}

export interface BenchFilters {
  kind: BenchKind | 'all';
  model: string;
  status: BenchStatus | 'all';
  /** “none”: one-off runs only (default); “all”: including sweep runs. */
  sweeps: 'none' | 'all';
}

/** Maximum number of runs loaded (the server caps it too). */
const HISTORY_LIMIT = 500;

interface BenchState {
  runs: BenchRun[];
  live: BenchLive | null;
  loaded: boolean;
  devices: BenchDevice[] | null;
  filters: BenchFilters;
  form: BenchForm;
  errors: Partial<Record<FormField, string>>;
  selected: number[];
  launching: boolean;
  load(): Promise<void>;
  loadDevices(): Promise<void>;
  setFilters(f: Partial<BenchFilters>): void;
  setForm(patch: Partial<BenchForm>): void;
  fromProfile(id: number | null): Promise<void>;
  rerun(run: BenchRun): void;
  /** “confirm”: the managed server is running, the client must ask before retrying with stopServer. */
  launch(stopServer?: boolean): Promise<'ok' | 'confirm' | 'error'>;
  cancel(): Promise<void>;
  remove(id: number): Promise<void>;
  removeFailed(): Promise<void>;
  toProfile(id: number): Promise<Profile | null>;
  toggle(id: number): void;
}

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

export const useBench = create<BenchState>()((set, get) => ({
  runs: [],
  live: null,
  loaded: false,
  devices: null,
  filters: { kind: 'all', model: 'all', status: 'all', sweeps: 'none' },
  form: EMPTY_FORM,
  errors: {},
  selected: [],
  launching: false,

  async load() {
    try {
      const { runs, live } = await api<{ runs: BenchRun[]; live: BenchLive | null }>(
        `/bench/runs?sweep=${get().filters.sweeps}&limit=${HISTORY_LIMIT}`,
      );
      set({ runs, live, loaded: true, selected: get().selected.filter((id) => runs.some((r) => r.id === id)) });
    } catch (e) {
      fail(e);
    }
  },

  async loadDevices() {
    try {
      set({ devices: await api<BenchDevice[]>('/bench/devices') });
    } catch {
      set({ devices: [] });
    }
  },

  setFilters(f) {
    const prev = get().filters;
    set({ filters: { ...prev, ...f } });
    if (f.sweeps && f.sweeps !== prev.sweeps) void get().load();
  },

  setForm(patch) {
    const errors = { ...get().errors };
    for (const k of Object.keys(patch) as FormField[]) delete errors[k];
    set({ form: { ...get().form, ...patch }, errors });
  },

  async fromProfile(id) {
    const { form } = get();
    if (id === null) {
      set({ form: { ...form, profileId: null }, errors: {} });
      return;
    }
    try {
      const draft = await api<Pick<BenchSpec, 'modelPath' | 'mmprojPath' | 'profileId' | 'params' | 'serverArgs'>>(
        `/bench/from-profile/${id}`,
      );
      set({
        form: formFromSpec(draft, { ...EMPTY_FORM, kind: form.kind, p: form.p, n: form.n, r: form.r }),
        errors: {},
      });
    } catch (e) {
      fail(e);
    }
  },

  rerun(run) {
    set({ form: formFromSpec(run.spec), errors: {} });
  },

  async launch(stopServer = false) {
    const built = specFromForm(get().form);
    if ('error' in built) {
      set({ errors: { [built.field]: built.error } });
      return 'error';
    }
    set({ launching: true });
    using _launching = defer(() => set({ launching: false }));
    try {
      await api<BenchRun>('/bench/run', { method: 'POST', body: JSON.stringify({ spec: built.spec, stopServer }) });
      set({ errors: {} });
      return 'ok';
    } catch (e) {
      if (e instanceof ApiError && e.code === 'server-running') return 'confirm';
      if (e instanceof ApiError && e.issues.length > 0) {
        const errors: Partial<Record<FormField, string>> = {};
        for (const i of e.issues) errors[fieldOf(i.path)] ??= i.message;
        set({ errors });
      } else fail(e);
      return 'error';
    }
  },

  async cancel() {
    const live = get().live;
    if (!live) return;
    try {
      await api(`/bench/${live.runId}/cancel`, { method: 'POST' });
    } catch (e) {
      fail(e);
    }
  },

  async remove(id) {
    try {
      await api(`/bench/${id}`, { method: 'DELETE' });
      set({ runs: get().runs.filter((r) => r.id !== id), selected: get().selected.filter((s) => s !== id) });
    } catch (e) {
      fail(e);
    }
  },

  async removeFailed() {
    try {
      const { deleted } = await api<{ deleted: number }>('/bench/runs?failed=1', { method: 'DELETE' });
      toast.success(deleted === 0 ? 'No failed runs' : `${deleted} ${plural(deleted, 'run')} deleted`);
      await get().load();
    } catch (e) {
      fail(e);
    }
  },

  async toProfile(id) {
    try {
      const p = await api<Profile>(`/bench/${id}/to-profile`, { method: 'POST', body: '{}' });
      toast.success(`Profile “${p.name}” created`);
      return p;
    } catch (e) {
      fail(e);
      return null;
    }
  },

  toggle(id) {
    const s = get().selected;
    set({ selected: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] });
  },
}));

let started = false;
/** WS subscription (once): progress, created or finished runs; reload on every (re)connect. */
export function startBenchSync(): void {
  if (started) return;
  started = true;
  onWs('bench-progress', (m) => useBench.setState({ live: m.payload }));
  onWs('bench-run', ({ payload: run }) => {
    const { runs, filters } = useBench.getState();
    if (run.sweepId !== null && filters.sweeps === 'none') return;
    const i = runs.findIndex((r) => r.id === run.id);
    useBench.setState({ runs: i === -1 ? [run, ...runs] : runs.map((r) => (r.id === run.id ? run : r)) });
  });
  onWs('bench-deleted', ({ payload: { ids } }) => {
    const gone = new Set(ids);
    const { runs, selected } = useBench.getState();
    useBench.setState({ runs: runs.filter((r) => !gone.has(r.id)), selected: selected.filter((id) => !gone.has(id)) });
  });
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void useBench.getState().load();
  });
}

export const PHASE_LABEL: Record<BenchLive['phase'], string> = {
  'stopping-server': 'Stopping server',
  loading: 'Loading',
  warmup: 'Warming up',
  prompt: 'Prompt',
  generation: 'Generating',
  measure: 'Measuring',
  'restarting-server': 'Restarting server',
};

export const STATUS_LABEL: Record<BenchStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  ok: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const KIND_LABEL: Record<BenchKind, string> = { bench: 'llama-bench', server: 'server' };
