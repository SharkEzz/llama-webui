import { type BenchDevice, type BenchParams, type CacheType, deviceRole, type Fit, gpuDevices } from "@llama-webui/shared";
import type { ModelInfo } from "../models/gguf";
import { EXPERTS } from "../models/sizes";
import { computeBytes, fmtBytes, kvLayerBytes, marginBytes, MiB, recurrentBytes } from "./memory";

export interface PlacementInput {
  model: ModelInfo;
  /** Tous les devices de `--list-devices` (`-dev`, `-ot` et le `-dev` automatique y sont résolus). */
  devices: BenchDevice[];
  params: BenchParams;
  ctx: number;
  kv: { k: CacheType; v: CacheType };
  ub: number;
  mmprojBytes: number;
  ramAvailableBytes: number;
}

export interface PlacementMeasure {
  /** Devices retenus, dans l'ordre (le premier reçoit les tampons de calcul). */
  used: string[];
  /** Octets par device (poids, KV, tampons), dans l'ordre d'apparition. */
  vram: Map<string, number>;
  /** Octets en RAM (poids sur CPU, KV des couches sur CPU). */
  ram: number;
  /** Device de chaque couche répétée ("CPU" si elle n'est pas offloadée). */
  layerDevice: string[];
  cpuWeights: number;
  cpuExpertsBytes: number;
  cpuOtherBytes: number;
  gpuWeights: number;
  /** -dev ou -ot qui visent un device inconnu, motif -ot invalide. */
  issues: string[];
}

const LAYER = /^blk\.(\d+)\./;
const CPU = "CPU";

/** -ngl en nombre de couches (répétées + sortie) : absent, « all » ou « auto » = tout (llama-bench : -1, llama-server : --fit). */
function nglOf(p: BenchParams, layers: number): number {
  return typeof p.ngl === "number" ? p.ngl : layers + 1;
}

/** Les `-ot` dans l'ordre : premier motif qui correspond gagnant, comme llama.cpp. */
function overrides(p: BenchParams, issues: string[]): { re: RegExp; target: string }[] {
  const out: { re: RegExp; target: string }[] = [];
  for (const rule of p.ot ?? []) {
    const eq = rule.lastIndexOf("=");
    try {
      out.push({ re: new RegExp(rule.slice(0, eq)), target: rule.slice(eq + 1) });
    } catch {
      issues.push(`motif -ot invalide : ${rule.slice(0, eq)}`);
    }
  }
  return out;
}

/** Répartit chaque tenseur du GGUF entre devices et RAM selon les flags, puis ajoute KV, tampons et projecteur. */
export function measurePlacement(input: PlacementInput): PlacementMeasure {
  const { model, params } = input;
  const issues: string[] = [];
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  let used: BenchDevice[];
  if (params.dev) {
    used = [];
    for (const id of params.dev) {
      const d = byId.get(id);
      if (d && deviceRole(d, input.devices) !== "host") used.push(d);
      else if (id !== "none") issues.push(`device inconnu : ${id}`);
    }
  } else used = gpuDevices(input.devices);
  const L = model.blockCount;
  const ngl = used.length === 0 ? 0 : nglOf(params, L);
  const gpuLayers = Math.min(ngl, L);
  const start = L - gpuLayers;
  const outputOnGpu = used.length > 0 && ngl > L;

  // Tranches contiguës proportionnelles à -ts (sinon à la VRAM libre, comme llama.cpp), dans l'ordre de -dev.
  const ts = params.ts && params.ts.length === used.length && params.ts.some((x) => x > 0) ? params.ts : used.map((d) => d.freeMib || d.totalMib);
  const sum = ts.reduce((a, b) => a + b, 0);
  let acc = 0;
  const cum = ts.map((x) => (acc += x) / sum);
  const deviceAt = (i: number): string => {
    if (used.length === 0 || i < start) return CPU;
    if (params.sm === "none" || used.length === 1) return used[0]!.id;
    const frac = (i - start) / Math.max(1, gpuLayers);
    const j = cum.findIndex((c) => frac < c);
    return used[j === -1 ? used.length - 1 : j]!.id;
  };
  const layerDevice = Array.from({ length: L }, (_, i) => deviceAt(i));
  const lastDevice = used.at(-1)?.id ?? CPU;
  const rules = overrides(params, issues);
  const ncmoe = params.ncmoe ?? 0;

  const vram = new Map<string, number>(used.map((d) => [d.id, 0]));
  const add = (where: string, bytes: number) => {
    if (where === CPU) return;
    if (!vram.has(where)) {
      if (!byId.has(where)) issues.push(`device inconnu : ${where}`);
      vram.set(where, 0);
    }
    vram.set(where, vram.get(where)! + bytes);
  };
  let ram = 0;
  let cpuWeights = 0;
  let cpuExpertsBytes = 0;
  let cpuOtherBytes = 0;
  let gpuWeights = 0;
  for (const t of model.tensors) {
    const m = LAYER.exec(t.name);
    const layer = m ? Number(m[1]) : null;
    let target: string;
    const rule = rules.find((r) => r.re.test(t.name));
    if (rule) target = byId.has(rule.target) ? rule.target : CPU;
    else if (layer !== null && layer < ncmoe && EXPERTS.test(t.name)) target = CPU;
    else if (t.name.startsWith("token_embd.")) target = CPU;
    else if (layer !== null) target = layerDevice[layer] ?? (outputOnGpu ? lastDevice : CPU);
    else target = outputOnGpu ? lastDevice : CPU;
    if (target === CPU) {
      ram += t.bytes;
      cpuWeights += t.bytes;
      if (EXPERTS.test(t.name)) cpuExpertsBytes += t.bytes;
      else if (layer !== null) cpuOtherBytes += t.bytes;
    } else {
      add(target, t.bytes);
      gpuWeights += t.bytes;
    }
  }
  for (let i = 0; i < L; i++) {
    const kv = kvLayerBytes(model, i, input.ctx, input.kv);
    if (layerDevice[i] === CPU) ram += kv;
    else add(layerDevice[i]!, kv);
  }
  const extras = computeBytes(model, input.ub) + input.mmprojBytes + recurrentBytes(model);
  if (used.length > 0 && gpuLayers > 0) add(used[0]!.id, extras);
  else ram += extras;
  return { used: used.map((d) => d.id), vram, ram, layerDevice, cpuWeights, cpuExpertsBytes, cpuOtherBytes, gpuWeights, issues: [...new Set(issues)] };
}

const MIN_FREE_RATIO = 0.95;

/**
 * Tient (« fits ») : chaque device sous 95 % de son budget (total − marge) et la RAM suffit ; limite (« tight ») : sous le
 * budget, ou RAM dépassée (mmap relit le reste sur le disque : lent, pas un échec) ; sinon « no ».
 */
export function fitOf(input: PlacementInput, measured: PlacementMeasure = measurePlacement(input)): Fit {
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  const vram = [...measured.vram].map(([device, bytes]) => {
    const totalBytes = (byId.get(device)?.totalMib ?? 0) * MiB;
    return { device, bytes, totalBytes, budget: Math.max(0, totalBytes - marginBytes(totalBytes)) };
  });
  const base = { vram, ramBytes: measured.ram, ramAvailableBytes: input.ramAvailableBytes };
  const unknown = measured.issues.find((i) => i.startsWith("device inconnu"));
  if (unknown) return { ...base, verdict: "no", reason: unknown };
  const over = vram.find((v) => v.bytes > v.budget);
  if (over) return { ...base, verdict: "no", reason: `${over.device} : ${fmtBytes(over.bytes)} pour ${fmtBytes(over.budget)} utilisables` };
  const near = vram.find((v) => v.bytes > MIN_FREE_RATIO * v.budget);
  if (measured.ram > input.ramAvailableBytes)
    return { ...base, verdict: "tight", reason: `RAM : ${fmtBytes(measured.ram)} pour ${fmtBytes(input.ramAvailableBytes)} disponibles, le reste est relu sur le disque` };
  if (near) return { ...base, verdict: "tight", reason: `${near.device} : ${fmtBytes(near.bytes)} pour ${fmtBytes(near.budget)} utilisables, marge réduite` };
  return { ...base, verdict: "fits", reason: null };
}
