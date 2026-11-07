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
import { computeBytes, fmtBytes, GiB, MiB, marginBytes } from './memory';
import { fitOf, measurePlacement, type PlacementInput, type PlacementMeasure } from './placement';

export interface EstimateInput {
  model: ModelInfo;
  hw: TuningHardware;
  preset: PresetId;
  mmprojBytes: number;
  /** Valeurs imposées par l'utilisateur : la recherche trouve le meilleur placement sous ces contraintes. */
  pinned?: Partial<BenchParams>;
  /** Contexte imposé. */
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

/** Une famille de placement sur un jeu de cartes : produit des flags pour (ctx, kv, ub), ou null si rien ne tient. */
type Kind = { name: 'gpu' | 'moe-cpu' | 'partial' | 'cpu'; cards: BenchDevice[] };

/**
 * Recommandation par règles (adaptée de l'estimateur de llama-tui) : cartes CUDA puis Vulkan (doublons et iGPU exclus),
 * `-ncmoe` pour les MoE qui débordent, `-ngl` partiel pour les denses, puis CPU seul. Le préréglage « 100 Go » place
 * d'emblée les experts en RAM sur toutes les cartes et accepte que la RAM déborde (mmap : relecture NVMe).
 */
/** « experts de la première couche », « experts des 8 premières couches ». */
const firstLayers = (n: number) => (n === 1 ? 'experts de la première couche' : `experts des ${n} premières couches`);

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

  const budget = (d: BenchDevice) => Math.max(0, d.totalMib * MiB - marginBytes(d.totalMib * MiB));
  const gpus = gpuDevices(hw.devices).filter((d) => budget(d) >= TS_UNIT);
  // CUDA d'abord (dans l'ordre de --list-devices : CUDA0 est la carte la plus rapide ici), puis les autres.
  const ordered = [...gpus.filter((d) => d.backend === 'CUDA'), ...gpus.filter((d) => d.backend !== 'CUDA')];
  const cuda = ordered.filter((d) => d.backend === 'CUDA');
  const pinnedCards = pinned.dev?.map((id) => byId.get(id)).filter((d): d is BenchDevice => !!d);

  const sets: BenchDevice[][] = [];
  const addSet = (s: BenchDevice[]) => {
    if (s.length > 0 && !sets.some((x) => x.map((d) => d.id).join() === s.map((d) => d.id).join())) sets.push(s);
  };
  if (pinnedCards) addSet(pinnedCards);
  else {
    // Chaque CUDA seule, la paire CUDA, puis les autres cartes seules (plus lentes ici), puis toutes.
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

  /** -ts proportionnel au budget de chaque carte, moins les tampons sur la première ; null sur une seule carte. */
  const tsOf = (cards: BenchDevice[], ub: number): number[] | undefined => {
    if (cards.length < 2) return undefined;
    const extras = computeBytes(model, ub) + mmprojBytes;
    return cards.map((d, i) => Math.max(1, Math.round(Math.max(0, budget(d) - (i === 0 ? extras : 0)) / TS_UNIT)));
  };

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

  /** Le plus grand contexte (multiple de 1024) qui tient avec cette famille. */
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
    // Une carte quand tout y tient, au contexte visé et dans le cache préféré ; ensuite seulement on réduit.
    // Une configuration avec de la marge passe avant une configuration « limite » plus simple.
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
  if (pinned.ncmoe && !isMoe) warnings.push('modèle dense : -ncmoe sans effet');

  if (!found) {
    // Rien ne tient : on montre quand même la configuration la plus simple, sans la valider.
    const ctx = input.ctx ?? preset.ctxMin;
    const kv: Kv = noFa ? 'f16' : 'q8_0';
    const params: BenchParams = {
      ...(widest.length ? { ngl: 'all' as const, dev: widest.map((d) => d.id) } : { ngl: 0 }),
      ...common(kv, 512),
      ...pinned,
    };
    const pi: PlacementInput = {
      model,
      devices: hw.devices,
      params,
      ctx,
      kv: { k: kv, v: kv },
      ub: params.ub ?? 512,
      mmprojBytes,
      ramAvailableBytes: hw.ramAvailableBytes,
    };
    const m = measurePlacement(pi);
    const fit = fitOf(pi, m);
    const reason =
      fit.reason ??
      `modèle trop gros : ${fmtBytes(m.ram)} de RAM nécessaires, ${fmtBytes(hw.ramAvailableBytes)} disponibles`;
    return {
      ok: false,
      reason,
      preset: preset.id,
      params,
      ctx,
      kv,
      serverArgs: [...serverArgs(params), '-c', String(ctx), '--fit', 'off'],
      rows: [],
      fit: { ...fit, verdict: 'no', reason },
      ramOverflowBytes: Math.max(0, m.ram - hw.ramAvailableBytes),
      diskReadBytesPerToken: 0,
      warnings: [...warnings, ...m.issues],
    };
  }

  const { params, ctx, kv, m, fit } = found;
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
        ? `${firstLayers(params.ncmoe)} en RAM ; attention, normes et experts restants sur ${cards}`
        : `${firstLayers(params.ncmoe)} en RAM (${fmtBytes(m.cpuExpertsBytes)})`,
    );
  if (params.ngl === 'all')
    row(
      '-ngl',
      'all',
      params.ncmoe
        ? 'toutes les couches sur GPU, sauf les experts ci-dessus'
        : `${fmtBytes(m.gpuWeights)} de poids tiennent dans ${fmtBytes(totalBudget)} utilisables`,
    );
  else if (typeof params.ngl === 'number' && params.ngl > 0)
    row('-ngl', String(params.ngl), `${params.ngl} couches sur ${L} tiennent, le reste en RAM`);
  else row('-ngl', '0', 'pas une couche ne tient : tout en RAM');
  if (params.dev && params.dev[0] !== 'none')
    row(
      '-dev',
      params.dev.join(','),
      params.dev.length === 1
        ? 'une seule carte : pas de saut PCIe'
        : `${params.dev.length} cartes, ${params.dev[0]} reçoit les tampons de calcul`,
    );
  if (params.ts) row('-ts', params.ts.join(','), 'réparti selon la VRAM utilisable de chaque carte');
  const kvTotal = [...m.vram.values()].reduce((a, b) => a + b, 0) + m.ram;
  row('-c', String(ctx), `${fmtBytes(kvTotal)} estimés au total, cache KV ${kv} compris, marge conservée`);
  if (params.fa)
    row(
      '-fa',
      'on',
      kv === 'f16' ? 'attention plus rapide, tampons de calcul plus petits' : 'requis pour le cache KV quantifié',
    );
  row('-ctk / -ctv', kv, kv === 'f16' ? 'le budget le permet, pas de perte' : 'cache divisé par 2, perte négligeable');
  row('-t', String(threads), `${threads} cœurs physiques`);
  row(
    '-b / -ub',
    `${batch} / ${params.ub}`,
    params.ub === 512 && batch === DEFAULT_BATCH ? 'défaut' : 'prompt processing plus rapide, marge VRAM suffisante',
  );
  row('--fit', 'off', 'ce qui est mesuré est exactement ce qui est écrit');
  if (mlock) row('--mlock', '', 'tout le modèle en mémoire, RAM suffisante');
  if (numa) row('--numa', 'distribute', 'plusieurs nœuds NUMA');

  if (typeof params.ngl === 'number' && params.ngl > 0)
    warnings.push(`génération lente : ${L - params.ngl} couches sur ${L} en RAM`);
  if (params.ncmoe) warnings.push(`${firstLayers(params.ncmoe)} en RAM : génération ralentie`);
  if (params.ngl === 0) warnings.push('VRAM insuffisante : tout en RAM');
  if (ramOverflowBytes > 0)
    warnings.push(
      `déborde la RAM de ${fmtBytes(ramOverflowBytes)} : lecture NVMe ≈ ${fmtBytes(diskReadBytesPerToken)} par jeton généré`,
    );
  if (fit.verdict === 'tight' && fit.reason && ramOverflowBytes === 0) warnings.push(fit.reason);
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
