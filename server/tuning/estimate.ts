import {
  type BenchDevice,
  type BenchParams,
  type CacheType,
  type Estimate,
  type Fit,
  gpuDevices,
  type PresetId,
  presetOf,
  type Recommendation,
  serverArgs,
  type TuningHardware,
} from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf';
import { EXPERTS } from '../models/sizes';
import { budgetBytes, computeBytes, fmtBytes, GiB, MiB } from './memory';
import { fitOf, measurePlacement, type PlacementInput, type PlacementMeasure } from './placement';

export interface EstimateInput {
  model: ModelInfo;
  hw: TuningHardware;
  preset: PresetId;
  mmprojBytes: number;
  /** Values pinned by the user: the search finds the best placement under these constraints. */
  pinned?: Partial<BenchParams>;
  /** Pinned context. */
  ctx?: number;
}

type Kv = 'f16' | 'q8_0';
const CTX_STEP = 4096;
const TS_UNIT = 256 * MiB;
const DEFAULT_BATCH = 2048;

interface Tried {
  params: BenchParams;
  ctx: number;
  kv: Kv;
  ub: number;
  fit: Fit;
  m: PlacementMeasure;
}

/** A placement family over a set of cards: yields flags for (ctx, kv, ub), or null if nothing fits. */
type Kind = { name: 'gpu' | 'moe-cpu' | 'partial' | 'cpu'; cards: BenchDevice[] };

/**
 * Rule-based recommendation (adapted from llama-tui's estimator): CUDA cards then Vulkan (duplicates and iGPU excluded),
 * `-ncmoe` for MoEs that overflow, partial `-ngl` for dense models, then CPU only. The “100 GB model” preset puts the
 * experts in RAM right away across all cards and accepts a RAM overflow (mmap: re-reads from NVMe).
 */
/** “experts of the first layer”, “experts of the first 8 layers”. */
const firstLayers = (n: number) => (n === 1 ? 'experts of the first layer' : `experts of the first ${n} layers`);

/** The K and V cache types the flags give llama.cpp (-ctv defaults to f16, not to -ctk). */
const cacheOf = (p: BenchParams): { k: CacheType; v: CacheType } => ({
  k: (p.ctk ?? 'f16') as CacheType,
  v: (p.ctv ?? 'f16') as CacheType,
});

export function estimate(input: EstimateInput): Estimate {
  const { model, hw, mmprojBytes } = input;
  const pinned = input.pinned ?? {};
  const preset = presetOf(input.preset);
  const L = model.blockCount;
  const isMoe = model.expertCount > 0 && model.tensors.some((t) => EXPERTS.test(t.name));
  const allowOverflow = input.preset === 'big';
  const threads = pinned.t ?? Math.max(1, hw.cpu.physicalCores);
  const batch = pinned.b ?? DEFAULT_BATCH;
  const noFa = pinned.fa === 'off';
  const byId = new Map(hw.devices.map((d) => [d.id, d]));

  const budget = budgetBytes;
  const gpus = gpuDevices(hw.devices).filter((d) => budget(d) >= TS_UNIT);
  // CUDA first (in --list-devices order: CUDA0 is the fastest card here), then the others.
  const ordered = [...gpus.filter((d) => d.backend === 'CUDA'), ...gpus.filter((d) => d.backend !== 'CUDA')];
  const cuda = ordered.filter((d) => d.backend === 'CUDA');
  const pinnedCards = pinned.dev?.map((id) => byId.get(id)).filter((d): d is BenchDevice => !!d);

  const sets: BenchDevice[][] = [];
  const addSet = (s: BenchDevice[]) => {
    if (s.length > 0 && !sets.some((x) => x.map((d) => d.id).join() === s.map((d) => d.id).join())) sets.push(s);
  };
  if (pinnedCards) addSet(pinnedCards);
  else {
    // Each CUDA card alone, the CUDA pair, then the other cards alone (slower here), then all of them.
    for (const d of cuda) addSet([d]);
    if (cuda.length >= 2) addSet(cuda);
    for (const d of ordered) addSet([d]);
    addSet(ordered);
  }
  const widest = sets.reduce<BenchDevice[]>((a, s) => (s.length > a.length ? s : a), []);
  const kinds: Kind[] = [];
  if (input.preset === 'big' && widest.length > 0) {
    if (isMoe) kinds.push({ name: 'moe-cpu', cards: widest });
    kinds.push({ name: 'partial', cards: widest });
  } else if (widest.length > 0) {
    for (const s of sets) kinds.push({ name: 'gpu', cards: s });
    if (isMoe) kinds.push({ name: 'moe-cpu', cards: widest });
    kinds.push({ name: 'partial', cards: widest });
  }
  kinds.push({ name: 'cpu', cards: [] });

  const kvs: Kv[] = noFa
    ? ['f16']
    : pinned.ctk
      ? [pinned.ctk === 'f16' ? 'f16' : 'q8_0']
      : preset.kvPreferred === 'f16'
        ? ['f16', 'q8_0']
        : ['q8_0'];
  const ubs = pinned.ub ? [pinned.ub] : preset.ub === 512 ? [512] : [preset.ub, 512];
  const ctxMax = Math.max(preset.ctxMin, Math.floor((model.contextLength || preset.ctxMin) / 1024) * 1024);

  /** -ts proportional to each card's budget, minus the buffers on the first one; undefined on a single card. */
  const tsOf = (cards: BenchDevice[], ub: number): number[] | undefined => {
    if (cards.length < 2) return undefined;
    const extras = computeBytes(model, ub) + mmprojBytes;
    return cards.map((d, i) => Math.max(1, Math.round(Math.max(0, budget(d) - (i === 0 ? extras : 0)) / TS_UNIT)));
  };

  /** The smallest RAM need among the candidates that fit in VRAM but not in RAM: why nothing fits, if nothing does. */
  let ramBlocked: number | null = null;

  const tryParams = (params: BenchParams, ctx: number, kv: Kv, ub: number): Tried | null => {
    const p: BenchParams = { ...params, ...pinned };
    const pi: PlacementInput = {
      model,
      devices: hw.devices,
      params: p,
      ctx,
      kv: { k: (p.ctk ?? kv) as CacheType, v: (p.ctv ?? kv) as CacheType },
      ub: p.ub ?? ub,
      mmprojBytes,
      ramAvailableBytes: hw.ramAvailableBytes,
    };
    const m = measurePlacement(pi);
    const fit = fitOf(pi, m);
    const okRam = allowOverflow || m.ram <= hw.ramAvailableBytes;
    if (fit.verdict !== 'no' && !okRam) ramBlocked = Math.min(ramBlocked ?? m.ram, m.ram);
    return fit.verdict !== 'no' && okRam ? { params: p, ctx, kv, ub, fit, m } : null;
  };

  const common = (kv: Kv, ub: number): BenchParams => ({
    ...(noFa ? {} : { fa: 'on' as const }),
    ctk: kv,
    ctv: kv,
    t: threads,
    b: batch,
    ub,
  });

  const fitKind = (k: Kind, ctx: number, kv: Kv, ub: number): Tried | null => {
    const dev = k.cards.map((d) => d.id);
    const ts = tsOf(k.cards, ub);
    const placed = (extra: BenchParams): BenchParams => ({
      ngl: 'all',
      ...extra,
      dev,
      ...(ts ? { ts } : {}),
      ...common(kv, ub),
    });
    switch (k.name) {
      case 'gpu':
        return tryParams(placed({}), ctx, kv, ub);
      case 'moe-cpu':
        if (pinned.ncmoe !== undefined) return tryParams(placed({ ncmoe: pinned.ncmoe }), ctx, kv, ub);
        for (let n = 1; n <= L; n++) {
          const r = tryParams(placed({ ncmoe: n }), ctx, kv, ub);
          if (r) return r;
        }
        return null;
      case 'partial':
        if (pinned.ngl !== undefined) return tryParams(placed({ ngl: pinned.ngl }), ctx, kv, ub);
        for (let n = L - 1; n >= 1; n--) {
          const r = tryParams(placed({ ngl: n }), ctx, kv, ub);
          if (r) return r;
        }
        return null;
      case 'cpu':
        return tryParams({ ngl: 0, dev: ['none'], ...common(kv, ub) }, ctx, kv, ub);
    }
  };

  const ctxList = (): number[] => {
    if (input.ctx) return [input.ctx];
    const out: number[] = [];
    for (let c = Math.min(preset.ctxTarget, ctxMax); c > preset.ctxMin; c -= CTX_STEP) out.push(c);
    out.push(preset.ctxMin);
    return out;
  };

  /** The largest context (multiple of 1024) that fits with this family. */
  const largest = (k: Kind, kv: Kv): Tried | null => {
    for (const ub of ubs) {
      let lo = fitKind(k, preset.ctxMin, kv, ub);
      if (!lo) continue;
      let a = preset.ctxMin;
      let b = ctxMax;
      const top = fitKind(k, b, kv, ub);
      if (top) return top;
      while (b - a > 1024) {
        const mid = Math.floor((a + b) / 2 / 1024) * 1024;
        const r = fitKind(k, mid, kv, ub);
        if (r) [a, lo] = [mid, r];
        else b = mid;
      }
      return lo;
    }
    return null;
  };

  const search = (): Tried | null => {
    if (preset.ctxTarget === Number.POSITIVE_INFINITY && !input.ctx) {
      for (const kv of kvs) {
        let best: Tried | null = null;
        for (const k of kinds) {
          const r = largest(k, kv);
          if (r && (!best || r.ctx > best.ctx)) best = r;
          if (best && k.name !== 'gpu') break;
        }
        if (best) return best;
      }
      return null;
    }
    // One card when everything fits on it, at the target context and with the preferred cache; only then scale down.
    // A configuration with headroom wins over a simpler “tight” one.
    const target = ctxList()[0]!;
    let tight: Tried | null = null;
    for (const k of kinds.filter((x) => x.name === 'gpu'))
      for (const ub of ubs) {
        const r = fitKind(k, target, kvs[0]!, ub);
        if (r?.fit.verdict === 'fits') return r;
        tight ??= r;
      }
    if (tight) return tight;
    for (const k of kinds)
      for (const kv of kvs)
        for (const ctx of ctxList())
          for (const ub of ubs) {
            const r = fitKind(k, ctx, kv, ub);
            if (r) return r;
          }
    return null;
  };

  const found = search();
  const warnings: string[] = [];
  if (pinned.ncmoe && !isMoe) warnings.push('dense model: -ncmoe has no effect');

  if (!found) {
    // Nothing fits: still show the simplest configuration, without validating it.
    const ctx = input.ctx ?? preset.ctxMin;
    const params: BenchParams = {
      ...(widest.length ? { ngl: 'all' as const, dev: widest.map((d) => d.id) } : { ngl: 0 }),
      ...common(noFa ? 'f16' : 'q8_0', 512),
      ...pinned,
    };
    const cache = cacheOf(params);
    const pi: PlacementInput = {
      model,
      devices: hw.devices,
      params,
      ctx,
      kv: cache,
      ub: params.ub ?? 512,
      mmprojBytes,
      ramAvailableBytes: hw.ramAvailableBytes,
    };
    const m = measurePlacement(pi);
    const fit = fitOf(pi, m);
    // The placements with weights in RAM fitted in VRAM but not in RAM: that is the limit to report, not the VRAM of
    // the all-GPU fallback shown below (#25).
    const reason =
      ramBlocked !== null
        ? `not enough RAM: ${fmtBytes(ramBlocked)} needed with weights in RAM, ${fmtBytes(hw.ramAvailableBytes)} available`
        : (fit.reason ??
          `model too large: ${fmtBytes(m.ram)} of RAM needed, ${fmtBytes(hw.ramAvailableBytes)} available`);
    return {
      ok: false,
      reason,
      preset: preset.id,
      params,
      ctx,
      kv: cache.k,
      serverArgs: [...serverArgs(params), '-c', String(ctx), '--fit', 'off'],
      rows: [],
      fit: { ...fit, verdict: 'no', reason },
      ramOverflowBytes: Math.max(0, m.ram - hw.ramAvailableBytes),
      diskReadBytesPerToken: 0,
      warnings: [...warnings, ...m.issues],
    };
  }

  const { params, ctx, m, fit } = found;
  // Rows from the final flags: a pinned -fa or cache type wins over the searched one (#36).
  const cache = cacheOf(params);
  const kv = cache.k;
  const kvLabel = cache.k === cache.v ? cache.k : `${cache.k} / ${cache.v}`;
  const quantized = cache.k !== 'f16' || cache.v !== 'f16';
  const used = m.used;
  const ramOverflowBytes = Math.max(0, m.ram - hw.ramAvailableBytes);
  const activeCpu =
    (isMoe ? (m.cpuExpertsBytes * model.expertUsedCount) / Math.max(1, model.expertCount) : 0) + m.cpuOtherBytes;
  const diskReadBytesPerToken =
    ramOverflowBytes > 0 && m.cpuWeights > 0 ? activeCpu * Math.min(1, ramOverflowBytes / m.cpuWeights) : 0;
  const mlock =
    params.ngl !== 'all' &&
    m.cpuWeights > 0 &&
    ramOverflowBytes === 0 &&
    hw.ramAvailableBytes - m.ram >= 2 * GiB &&
    !params.ncmoe;
  const numa = hw.cpu.numaNodes > 1;

  const rows: Recommendation[] = [];
  const row = (flag: string, value: string, why: string) => rows.push({ flag, value, why });
  const totalBudget = fit.vram.reduce((a, v) => a + v.budget, 0);
  const cards = used.join(', ');
  if (params.ngl === 'all' && params.ncmoe)
    row(
      '-ncmoe',
      String(params.ncmoe),
      input.preset === 'big'
        ? `${firstLayers(params.ncmoe)} in RAM; attention, norms and remaining experts on ${cards}`
        : `${firstLayers(params.ncmoe)} in RAM (${fmtBytes(m.cpuExpertsBytes)})`,
    );
  if (params.ngl === 'all')
    row(
      '-ngl',
      'all',
      params.ncmoe
        ? 'all layers on GPU, except the experts above'
        : `${fmtBytes(m.gpuWeights)} of weights fit in ${fmtBytes(totalBudget)} usable`,
    );
  else if (typeof params.ngl === 'number' && params.ngl > 0)
    row('-ngl', String(params.ngl), `${params.ngl} of ${L} layers fit, the rest in RAM`);
  else row('-ngl', '0', 'not a single layer fits: everything in RAM');
  if (params.dev && params.dev[0] !== 'none')
    row(
      '-dev',
      params.dev.join(','),
      params.dev.length === 1
        ? 'single card: no PCIe hop'
        : `${params.dev.length} cards, ${params.dev[0]} gets the compute buffers`,
    );
  if (params.ts) row('-ts', params.ts.join(','), 'split by the usable VRAM of each card');
  const kvTotal = [...m.vram.values()].reduce((a, b) => a + b, 0) + m.ram;
  row('-c', String(ctx), `${fmtBytes(kvTotal)} estimated in total, ${kvLabel} KV cache included, margin kept`);
  if (params.fa)
    row(
      '-fa',
      params.fa,
      params.fa === 'on'
        ? quantized
          ? 'required for the quantized KV cache'
          : 'faster attention, smaller compute buffers'
        : params.fa === 'auto'
          ? 'pinned: llama.cpp decides'
          : 'pinned: attention without flash attention',
    );
  row(
    '-ctk / -ctv',
    kvLabel,
    pinned.ctk || pinned.ctv ? 'pinned' : quantized ? 'cache halved, negligible loss' : 'the budget allows it, no loss',
  );
  row('-t', String(threads), `${threads} physical ${threads === 1 ? 'core' : 'cores'}`);
  row(
    '-b / -ub',
    `${batch} / ${params.ub}`,
    params.ub === 512 && batch === DEFAULT_BATCH ? 'default' : 'faster prompt processing, enough VRAM headroom',
  );
  row('--fit', 'off', 'what gets measured is exactly what gets written');
  if (mlock) row('--mlock', '', 'whole model locked in memory, enough RAM');
  if (numa) row('--numa', 'distribute', 'several NUMA nodes');

  if (typeof params.ngl === 'number' && params.ngl > 0)
    warnings.push(`slow generation: ${L - params.ngl} of ${L} layers in RAM`);
  if (params.ncmoe) warnings.push(`${firstLayers(params.ncmoe)} in RAM: slower generation`);
  if (params.ngl === 0) warnings.push('not enough VRAM: everything in RAM');
  if (ramOverflowBytes > 0)
    warnings.push(
      `overflows RAM by ${fmtBytes(ramOverflowBytes)}: NVMe read ≈ ${fmtBytes(diskReadBytesPerToken)} per generated token`,
    );
  if (fit.verdict === 'tight' && fit.reason && ramOverflowBytes === 0) warnings.push(fit.reason);
  if (params.fa === 'off' && quantized) warnings.push('a quantized KV cache needs flash attention: -fa off may fail');
  warnings.push(...m.issues);

  return {
    ok: true,
    reason: null,
    preset: preset.id,
    params,
    ctx,
    kv,
    serverArgs: [
      ...serverArgs(params),
      '-c',
      String(ctx),
      '--fit',
      'off',
      ...(mlock ? ['--mlock'] : []),
      ...(numa ? ['--numa', 'distribute'] : []),
    ],
    rows,
    fit,
    ramOverflowBytes,
    diskReadBytesPerToken,
    warnings,
  };
}
