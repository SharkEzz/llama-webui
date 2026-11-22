import {
  type BenchDevice,
  type BenchLive,
  type BenchParams,
  type BenchRun,
  type ChecksReport,
  type DiskSpeed,
  defer,
  type Estimate,
  gpuDevices,
  type PlanResult,
  type PresetId,
  type Profile,
  presetOf,
  type Sweep,
  type SweepLive,
  type SweepSpace,
  type TuningHardware,
  withCtx,
} from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { call, errorMessage, errorTag } from './api';
import { formatShortDate } from './format';
import { onWs, useWs } from './ws';

interface TuningState {
  hardware: TuningHardware | null;
  modelPath: string | null;
  mmprojPath: string | null;
  profileId: number | null;
  /** Profile server flags outside the measurable fields (-c, --spec-type…): carried over to the sweep and the created profile. */
  serverArgs: ReadonlyArray<string>;
  /** Profile flags the estimator sets itself (-ngl, -ctk…): replaced by the recommendation unless pinned. */
  profileParams: BenchParams;
  preset: PresetId;
  pinned: Partial<BenchParams>;
  estimate: Estimate | null;
  estimating: boolean;
  estimateError: string | null;
  base: BenchParams;
  space: SweepSpace;
  includeUnfit: boolean;
  run: { name: string; p: number; n: number; r: number };
  plan: PlanResult | null;
  planning: boolean;
  planError: string | null;
  launching: boolean;
  sweeps: ReadonlyArray<Sweep>;
  sweepsLoaded: boolean;
  current: { sweep: Sweep; runs: ReadonlyArray<BenchRun> } | null;
  sweepLive: SweepLive | null;
  live: BenchLive | null;
  checks: ChecksReport | null;
  checksModel: string | null;
  checksLoading: boolean;
  diskSpeed: DiskSpeed | null;
  measuring: boolean;

  loadHardware: () => Promise<void>;
  setModel: (path: string | null, mmproj?: string | null) => void;
  fromProfile: (id: number | null) => Promise<void>;
  setPreset: (id: PresetId) => void;
  pin: (patch: Partial<BenchParams>) => void;
  unpin: (key: keyof BenchParams) => void;
  setSpace: (patch: Partial<SweepSpace>) => void;
  setBase: (base: BenchParams) => void;
  setIncludeUnfit: (v: boolean) => void;
  setRun: (patch: Partial<TuningState['run']>) => void;
  suggestSpace: () => void;
  launch: (stopServer?: boolean) => Promise<'ok' | 'confirm' | 'error'>;
  loadSweeps: () => Promise<void>;
  open: (id: number | null) => Promise<void>;
  cancelSweep: (id: number) => Promise<void>;
  resume: (id: number, stopServer?: boolean) => Promise<'ok' | 'confirm' | 'error'>;
  validate: (id: number, n: number, stopServer?: boolean) => Promise<'ok' | 'confirm' | 'error'>;
  removeSweep: (id: number) => Promise<void>;
  toProfile: (runId: number) => Promise<Profile | null>;
  loadChecks: (modelPath: string | null) => Promise<void>;
  measureDisk: (modelPath: string) => Promise<void>;
}

const fail = (e: unknown) => void toast.error(errorMessage(e));
const DEBOUNCE_MS = 300;
let estimateTimer: ReturnType<typeof setTimeout> | null = null;
let planTimer: ReturnType<typeof setTimeout> | null = null;
let estimateSeq = 0;
let planSeq = 0;

const modelName = (p: string) =>
  p
    .split('/')
    .pop()!
    .replace(/\.gguf$/, '');

/** An action that takes the gate: a `ServerRunning` refusal → the client asks for confirmation. */
async function guarded(fn: () => Promise<unknown>): Promise<'ok' | 'confirm' | 'error'> {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    if (errorTag(e) === 'ServerRunning') return 'confirm';
    fail(e);
    return 'error';
  }
}

/** The profile's flags that the recommendation replaces: those not pinned to the same value. */
export function replacedProfileParams(profile: BenchParams, pinned: Partial<BenchParams>): BenchParams {
  const out: Record<string, unknown> = {};
  const pins: Readonly<Record<string, unknown>> = pinned;
  for (const [k, v] of Object.entries(profile)) if (JSON.stringify(pins[k]) !== JSON.stringify(v)) out[k] = v;
  return out;
}

/** Static -ot patterns: they send MoE experts to RAM (llama.cpp applies the first matching rule). */
const OT_TO_CPU = ['exps=CPU', 'blk\\.(\\d|1\\d)\\.ffn_.*_exps=CPU', 'blk\\.[0-9]\\.ffn_.*_exps=CPU'];

/** -ot suggestions: the RAM patterns, then the experts on each dedicated card of this machine (#23). */
export function otSuggestions(devices: ReadonlyArray<BenchDevice>): string[] {
  return [...OT_TO_CPU, ...gpuDevices(devices).map((d) => `ffn_.*_exps=${d.id}`)];
}

/** Space suggested around the recommendation: neighboring -ncmoe (MoE), GPU sets, -ub for the agent preset. */
export function suggestedSpace(e: Estimate, hw: TuningHardware, preset: PresetId): SweepSpace {
  const space: { -readonly [K in keyof SweepSpace]: SweepSpace[K] } = {};
  const n = e.params.ncmoe;
  if (n !== undefined && n > 0) space.ncmoe = [...new Set([n - 8, n - 4, n, n + 4, n + 8].filter((x) => x >= 0))];
  const gpus = gpuDevices(hw.devices);
  const biggest = gpus.toSorted((a, b) => b.totalMib - a.totalMib)[0];
  const sets = [
    e.params.dev,
    gpus.map((d) => d.id),
    gpus.filter((d) => d.backend === 'CUDA').map((d) => d.id),
    biggest ? [biggest.id] : [],
  ];
  const seen = new Set<string>();
  const dev = sets.filter(
    (s): s is ReadonlyArray<string> =>
      s !== undefined && s.length > 0 && s[0] !== 'none' && !seen.has(s.join()) && Boolean(seen.add(s.join())),
  );
  if (dev.length > 1) space.dev = dev;
  if (preset === 'agent') space.ub = [512, 2048];
  return space;
}

export const useTuning = create<TuningState>()((set, get) => {
  const scheduleEstimate = () => {
    if (estimateTimer) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => void runEstimate(), DEBOUNCE_MS);
  };
  const runEstimate = async () => {
    const { modelPath, mmprojPath, preset, pinned } = get();
    if (!modelPath) {
      set({ estimate: null, estimating: false, estimateError: null });
      return;
    }
    const seq = ++estimateSeq;
    set({ estimating: true });
    using _estimating = defer(() => {
      if (seq === estimateSeq) set({ estimating: false });
    });
    try {
      const estimate = await call((api) => api.tuning.estimate({ payload: { modelPath, mmprojPath, preset, pinned } }));
      if (seq === estimateSeq) set({ estimate, estimateError: null });
    } catch (e) {
      if (seq === estimateSeq) set({ estimate: null, estimateError: errorMessage(e) });
    }
  };
  const specBody = (modelPath: string) => {
    const s = get();
    return {
      name:
        s.run.name.trim() || `${modelName(modelPath)} · ${presetOf(s.preset).label} · ${formatShortDate(new Date())}`,
      modelPath,
      mmprojPath: s.mmprojPath,
      profileId: s.profileId,
      preset: s.preset,
      base: s.base,
      space: s.space,
      // The recommendation's context when the profile sets none: the validation would get the model's full one (#24).
      serverArgs: withCtx(s.serverArgs, s.estimate?.ctx),
      p: s.run.p,
      n: s.run.n,
      r: s.run.r,
      includeUnfit: s.includeUnfit,
    };
  };
  const schedulePlan = () => {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(() => void runPlan(), DEBOUNCE_MS);
  };
  const runPlan = async () => {
    const { modelPath } = get();
    if (!modelPath) {
      set({ plan: null, planError: null });
      return;
    }
    const seq = ++planSeq;
    set({ planning: true });
    using _planning = defer(() => {
      if (seq === planSeq) set({ planning: false });
    });
    try {
      const plan = await call((api) => api.tuning.plan({ payload: { spec: specBody(modelPath) } }));
      if (seq === planSeq) set({ plan, planError: null });
    } catch (e) {
      if (seq === planSeq) set({ plan: null, planError: errorMessage(e) });
    }
  };
  const refresh = () => {
    scheduleEstimate();
    schedulePlan();
  };

  return {
    hardware: null,
    modelPath: null,
    mmprojPath: null,
    profileId: null,
    serverArgs: [],
    profileParams: {},
    preset: 'chat',
    pinned: {},
    estimate: null,
    estimating: false,
    estimateError: null,
    base: {},
    space: {},
    includeUnfit: false,
    run: { name: '', p: 512, n: 128, r: 3 },
    plan: null,
    planning: false,
    planError: null,
    launching: false,
    sweeps: [],
    sweepsLoaded: false,
    current: null,
    sweepLive: null,
    live: null,
    checks: null,
    checksModel: null,
    checksLoading: false,
    diskSpeed: null,
    measuring: false,

    async loadHardware() {
      try {
        set({ hardware: await call((api) => api.tuning.hardware()) });
      } catch (e) {
        fail(e);
      }
    },

    setModel(path, mmproj = null) {
      set({ modelPath: path, mmprojPath: mmproj, estimate: null, plan: null });
      refresh();
    },

    async fromProfile(id) {
      if (id === null) {
        set({ profileId: null, serverArgs: [], profileParams: {} });
        return;
      }
      try {
        const d = await call((api) => api.bench.fromProfile({ params: { id } }));
        set({
          profileId: id,
          modelPath: d.modelPath,
          mmprojPath: d.mmprojPath,
          serverArgs: d.serverArgs,
          profileParams: d.params,
          estimate: null,
          plan: null,
        });
        refresh();
      } catch (e) {
        fail(e);
      }
    },

    setPreset(preset) {
      set({ preset });
      refresh();
    },

    pin(patch) {
      set({ pinned: { ...get().pinned, ...patch } });
      scheduleEstimate();
    },

    unpin(key) {
      const pinned = { ...get().pinned };
      delete pinned[key];
      set({ pinned });
      scheduleEstimate();
    },

    setSpace(patch) {
      const space = { ...get().space, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(space))
        if (space[k] === undefined || (Array.isArray(space[k]) && (space[k] as unknown[]).length === 0))
          delete space[k];
      set({ space });
      schedulePlan();
    },

    setBase(base) {
      set({ base });
      schedulePlan();
    },

    setIncludeUnfit(includeUnfit) {
      set({ includeUnfit });
      schedulePlan();
    },

    setRun(patch) {
      set({ run: { ...get().run, ...patch } });
      schedulePlan();
    },

    suggestSpace() {
      const { estimate, hardware, preset } = get();
      if (!estimate || !hardware) return;
      set({ base: estimate.params, space: suggestedSpace(estimate, hardware, preset) });
      schedulePlan();
    },

    async launch(stopServer = false) {
      set({ launching: true });
      using _launching = defer(() => set({ launching: false }));
      const { modelPath } = get();
      if (!modelPath) return 'error';
      return await guarded(async () => {
        const r = await call((api) => api.sweeps.create({ payload: { spec: specBody(modelPath), stopServer } }));
        set({ run: { ...get().run, name: '' } });
        await get().open(r.sweep.id);
      });
    },

    async loadSweeps() {
      try {
        const { sweeps, live } = await call((api) => api.sweeps.list());
        set({ sweeps, sweepLive: live, sweepsLoaded: true });
        const cur = get().current;
        if (cur) await get().open(cur.sweep.id);
      } catch (e) {
        fail(e);
      }
    },

    async open(id) {
      if (id === null) {
        set({ current: null });
        return;
      }
      try {
        set({ current: await call((api) => api.sweeps.get({ params: { id } })) });
      } catch (e) {
        if (errorTag(e) === 'SweepNotFound') set({ current: null });
        else fail(e);
      }
    },

    async cancelSweep(id) {
      try {
        await call((api) => api.sweeps.cancel({ params: { id } }));
      } catch (e) {
        fail(e);
      }
    },

    resume: (id, stopServer = false) =>
      guarded(() => call((api) => api.sweeps.resume({ params: { id }, payload: { stopServer } }))),

    validate: (id, n, stopServer = false) =>
      guarded(() => call((api) => api.sweeps.validate({ params: { id }, payload: { n, stopServer } }))),

    async removeSweep(id) {
      try {
        await call((api) => api.sweeps.remove({ params: { id } }));
        dropSweep(id);
      } catch (e) {
        fail(e);
      }
    },

    async toProfile(runId) {
      try {
        const p = await call((api) => api.bench.toProfile({ params: { id: runId } }));
        toast.success(`Profile “${p.name}” created`);
        return p;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async loadChecks(modelPath) {
      set({ checksLoading: true, checksModel: modelPath });
      using _loading = defer(() => set({ checksLoading: false }));
      try {
        const checks = await call((api) => api.tuning.checks({ query: modelPath ? { model: modelPath } : {} }));
        if (get().checksModel === modelPath) set({ checks });
      } catch (e) {
        fail(e);
      }
    },

    async measureDisk(modelPath) {
      set({ measuring: true });
      using _measuring = defer(() => set({ measuring: false }));
      try {
        const diskSpeed = await call((api) => api.tuning.diskSpeed({ payload: { modelPath } }));
        set({ diskSpeed });
        await get().loadChecks(modelPath);
      } catch (e) {
        fail(e);
      }
    },
  };
});

function dropSweep(id: number) {
  const s = useTuning.getState();
  useTuning.setState({
    sweeps: s.sweeps.filter((x) => x.id !== id),
    current: s.current?.sweep.id === id ? null : s.current,
  });
}

let started = false;
/** WS subscription (once): sweeps, progress, runs of the open sweep; reload on every (re)connect. */
export function startTuningSync(): void {
  if (started) return;
  started = true;
  onWs('sweep-progress', (m) => useTuning.setState({ sweepLive: m.payload }));
  onWs('bench-progress', (m) => useTuning.setState({ live: m.payload }));
  onWs('sweep', ({ payload: sweep }) => {
    const { sweeps, current } = useTuning.getState();
    const i = sweeps.findIndex((s) => s.id === sweep.id);
    useTuning.setState({
      sweeps: i === -1 ? [sweep, ...sweeps] : sweeps.map((s) => (s.id === sweep.id ? sweep : s)),
      current: current?.sweep.id === sweep.id ? { ...current, sweep } : current,
    });
  });
  onWs('bench-run', ({ payload: run }) => {
    const { current } = useTuning.getState();
    if (!current || run.sweepId !== current.sweep.id) return;
    const i = current.runs.findIndex((r) => r.id === run.id);
    const runs =
      i === -1
        ? [...current.runs, run].toSorted((a, b) => a.id - b.id)
        : current.runs.map((r) => (r.id === run.id ? run : r));
    useTuning.setState({ current: { ...current, runs } });
  });
  onWs('bench-deleted', ({ payload: { ids } }) => {
    const { current } = useTuning.getState();
    if (current) useTuning.setState({ current: { ...current, runs: current.runs.filter((r) => !ids.includes(r.id)) } });
  });
  onWs('sweep-deleted', ({ payload: { id } }) => dropSweep(id));
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void useTuning.getState().loadSweeps();
  });
}
