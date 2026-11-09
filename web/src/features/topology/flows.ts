import {
  type GpuSample,
  hostDevice,
  type ModelPlacement,
  type PlacementBuffer,
  pcieBps,
  placementTotals,
  type Snapshot,
  type TopologyGraph,
  type TopologyLink,
  type TopologyNode,
} from '@llama-webui/shared';
import type { Tone } from '@/components/glass/tones';
import { fmt, formatBps, formatBytes, formatPct, plural } from '@/lib/format';
import { FLOOR_BPS } from './smooth';

/*
 * Projects the snapshot (existing measurements) onto the hardware graph: what flows over each link and what to say
 * about each node. Pure functions, tested without DOM or Three.
 */

/** How close to its limit a link or a tank is; always shown next to its figure, never by color alone. */
export type Level = 'ok' | 'warn' | 'crit';

/** Share of a link's current capacity from which it turns amber, then red. */
export const LINK_WARN = 0.7;
export const LINK_CRIT = 0.9;
/** Fill (%) from which a tank's surface turns amber, then red. */
export const FILL_WARN_PCT = 85;
export const FILL_CRIT_PCT = 95;
/** Share of the capacity from which a badge spells it out: below, the figure is noise. */
const BADGE_PCT_MIN = 0.25;
/**
 * Throughput from which a link gets its badge while llama-server is at rest (8 MiB/s): background traffic (an idle GPU
 * exchanges a few MiB/s, a journal write) shows as a few streaks, without a badge. While the server loads or generates,
 * every link that carries streaks has its badge. The tooltips keep every figure.
 */
export const REST_BADGE_FLOOR_BPS = 8 * 1024 ** 2;

export function levelOf(value: number | null, warn: number, crit: number): Level {
  if (value === null) return 'ok';
  return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
}

export interface LinkFlow {
  /**
   * Bytes/s along the link, upstream → downstream (`from` → `to`): host → GPU, CPU → RAM writes and CPU → NVMe writes;
   * null = not measurable.
   */
  fwdBps: number | null;
  /** Bytes/s downstream → upstream: GPU → host, RAM → CPU reads and NVMe → CPU reads. */
  backBps: number | null;
  /**
   * Memory link without a perf measurement: CPU activity as a % of the machine (0–100), llama-server's scaled to the
   * thread count, otherwise the machine's, as a fallback.
   */
  activity: number | null;
  /** Link capacity in its current state (current Gen/width) and at its maximum; null = unknown. */
  capacityBps: number | null;
  maxBps: number | null;
  /** Busier direction over the current capacity (each direction has the full capacity); null = one of them unknown. */
  ratio: number | null;
  level: Level;
}

export interface Fact {
  label: string;
  value: string;
}

/** What a tank layer holds: the model's buffers (from the loading logs), the rest of the memory in use. */
export type LayerKind = 'model' | 'kv' | 'compute' | 'other' | 'used';

export interface TankLayer {
  kind: LayerKind;
  /** Share of the tank's capacity (0..100). */
  pct: number;
}

export interface NodeLive {
  /** 0..100: load (GPU, CPU utilization…) driving the glow; null = unknown. */
  loadPct: number | null;
  /** 0..100: fill (VRAM, RAM); null = not applicable. */
  fillPct: number | null;
  fillLevel: Level;
  /** Tank contents from the bottom up; their sum is the measured fill. Empty: not a tank, or nothing known. */
  layers: TankLayer[];
  /** Load of each CPU thread (0..100); empty for other blocks or without a sample. */
  cores: number[];
  /** Hidden or suspended card: dimmed, no values. */
  dim: boolean;
  /** Figure shown under the name; null = the name alone. */
  headline: string | null;
  /** 0..100: bar drawn next to the headline (load); null = no bar. */
  barPct: number | null;
  /** Second line under the name (memory in use); null = none. */
  sub: string | null;
  /** Tooltip lines. */
  facts: Fact[];
}

/** Values of a block that is not a tank and has nothing to add to its name and headline. */
const PLAIN: Pick<NodeLive, 'fillLevel' | 'layers' | 'cores' | 'barPct' | 'sub'> = {
  fillLevel: 'ok',
  layers: [],
  cores: [],
  barPct: null,
  sub: null,
};

const linkLabel = (gen: number | null | undefined, width: number | null | undefined) =>
  gen != null && width != null ? `Gen${gen} x${width}` : null;
const sum = (xs: (number | null)[]) => {
  const known = xs.filter((x): x is number => x !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

/** `proc.cpuPct` counts in cores (up to N × 100): scaled to the machine for a common scale with `system.cpuPct`. */
function cpuActivity(snapshot: Snapshot | null, cpu: TopologyNode | undefined): number | null {
  const threads = snapshot?.system?.corePct.length || Number(cpu?.detail.logicalThreads) || 0;
  const proc = snapshot?.proc?.cpuPct;
  if (proc != null && threads > 0) return Math.min(100, proc / threads);
  return snapshot?.system?.cpuPct ?? null;
}

const gpuOf = (snapshot: Snapshot | null, node: TopologyNode): GpuSample | undefined =>
  node.busId ? snapshot?.allGpus.find((g) => g.busId === node.busId) : undefined;

type Unrated = Omit<LinkFlow, 'ratio' | 'level'>;

export function linkFlows(graph: TopologyGraph, snapshot: Snapshot | null): Map<string, LinkFlow> {
  const out = new Map<string, LinkFlow>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const perDisk = snapshot?.disk?.perDisk;

  const base = (l: TopologyLink, gen = l.genCur, width = l.widthCur): Unrated => ({
    fwdBps: null,
    backBps: null,
    activity: null,
    capacityBps: l.kind === 'pcie' ? pcieBps(gen ?? l.genMax, width ?? l.widthMax) : null,
    maxBps: l.kind === 'pcie' ? pcieBps(l.genMax, l.widthMax) : null,
  });
  const set = (l: TopologyLink, f: Unrated) => {
    const peak = f.fwdBps === null && f.backBps === null ? null : Math.max(f.fwdBps ?? 0, f.backBps ?? 0);
    const ratio = peak !== null && f.capacityBps ? peak / f.capacityBps : null;
    out.set(l.id, { ...f, ratio, level: levelOf(ratio, LINK_WARN, LINK_CRIT) });
  };

  const leaves = graph.links.filter((l) => byId.get(l.to)?.kind !== 'chipset');
  for (const l of leaves) {
    const to = byId.get(l.to);
    if (!to) continue;
    if (l.kind === 'memory') {
      // CPU → RAM: writes; RAM → CPU: reads (memory controller, everything included). Without perf: activity.
      const bw = snapshot?.system?.memBw ?? null;
      set(l, {
        ...base(l),
        fwdBps: bw ? bw.writeBps : null,
        backBps: bw ? bw.readBps : null,
        activity: bw ? null : cpuActivity(snapshot, byId.get(l.from)),
      });
    } else if (to.kind === 'gpu') {
      const g = gpuOf(snapshot, to);
      set(l, {
        ...base(l, g?.pcieGen ?? l.genCur, g?.pcieWidth ?? l.widthCur),
        fwdBps: g?.pcieRxBps ?? null,
        backBps: g?.pcieTxBps ?? null,
      });
    } else if (to.kind === 'nvme') {
      // This NVMe's block counters: CPU → NVMe for writes; NVMe → CPU for reads.
      const rates = to.block ? perDisk?.[to.block] : undefined;
      set(l, { ...base(l), fwdBps: rates?.writeBps ?? null, backBps: rates?.readBps ?? null });
    } else set(l, base(l));
  }
  // A chipset carries the sum of whatever sits behind it.
  for (const l of graph.links) {
    if (out.has(l.id)) continue;
    const behind = graph.links.filter((c) => c.from === l.to).map((c) => out.get(c.id));
    set(l, {
      ...base(l),
      fwdBps: sum(behind.map((f) => f?.fwdBps ?? null)),
      backBps: sum(behind.map((f) => f?.backBps ?? null)),
    });
  }
  return out;
}

export interface LinkBadge {
  /** One line per measured direction. */
  lines: Fact[];
  /** Share of the link's current capacity, written out once it matters; null below. */
  pct: string | null;
  level: Level;
}

/**
 * What a link's badge says: the exact throughput in each direction, in the words of the device at its end. Null when
 * there is nothing to say: an idle link, one whose traffic is not measured, an internal connection. `busy`: llama-server
 * is loading, processing a prompt or generating.
 */
export function linkBadge(link: TopologyLink, to: TopologyNode, flow: LinkFlow, busy: boolean): LinkBadge | null {
  if (link.kind === 'internal') return null;
  const { fwdBps, backBps } = flow;
  if (Math.max(fwdBps ?? 0, backBps ?? 0) < (busy ? FLOOR_BPS : REST_BADGE_FLOOR_BPS)) return null;
  const line = (label: string, bps: number | null): Fact[] => (bps === null ? [] : [{ label, value: formatBps(bps) }]);
  // Words rather than arrows: memory sits behind the CPU and the devices in front, “up” would mean both.
  const lines =
    link.kind === 'memory' || to.kind === 'nvme'
      ? [...line('read', backBps), ...line('write', fwdBps)]
      : [...line(to.kind === 'chipset' ? '→ devices' : '→ GPU', fwdBps), ...line('→ host', backBps)];
  const shown = flow.ratio !== null && flow.ratio >= BADGE_PCT_MIN;
  return { lines, pct: shown ? formatPct(flow.ratio! * 100) : null, level: flow.level };
}

const pct = (part: number, total: number) => (total > 0 ? (100 * part) / total : null);

/**
 * Layers of a GPU tank. The level is the measured VRAM; the logs say what part of it is the model, its KV cache and
 * its compute buffers. When they announce more than what is allocated (still loading, tensor-parallel estimate), the
 * three shrink together: the measurement wins.
 */
function gpuLayers(g: GpuSample, buf: PlacementBuffer | undefined): { layers: TankLayer[]; otherBytes: number | null } {
  const total = g.vramTotalBytes;
  if (!(total > 0)) return { layers: [], otherBytes: null };
  const used = Math.min(g.vramUsedBytes, total);
  const known = buf ? buf.modelBytes + buf.kvBytes + buf.computeBytes : 0;
  if (!buf || known <= 0) return { layers: [{ kind: 'used', pct: (100 * used) / total }], otherBytes: null };
  const scale = known > used ? used / known : 1;
  const other = Math.max(0, used - known);
  const layer = (kind: LayerKind, bytes: number): TankLayer => ({ kind, pct: (100 * bytes) / total });
  return {
    layers: [
      layer('model', buf.modelBytes * scale),
      layer('kv', buf.kvBytes * scale),
      layer('compute', buf.computeBytes * scale),
      layer('other', other),
    ],
    otherBytes: other,
  };
}

export function nodeLive(
  graph: TopologyGraph,
  snapshot: Snapshot | null,
  placement: ModelPlacement | null,
  /** Flows already computed by the caller for this snapshot (avoids recomputing them). */
  flows: Map<string, LinkFlow> = linkFlows(graph, snapshot),
): Map<string, NodeLive> {
  const out = new Map<string, NodeLive>();
  const uplink = (id: string) => graph.links.find((l) => l.to === id);
  const bufferOf = (busId: string | undefined) =>
    busId ? placement?.buffers.find((b) => b.busId === busId) : undefined;
  const peers = peerGroups(graph, placement);

  for (const n of graph.nodes) {
    const facts: Fact[] = [];
    const add = (label: string, value: string | null | undefined) => {
      if (value) facts.push({ label, value });
    };
    const link = uplink(n.id);
    const flow = link ? flows.get(link.id) : undefined;

    if (n.kind === 'gpu') {
      const g = gpuOf(snapshot, n);
      if (g?.hidden || g?.suspended) {
        out.set(n.id, {
          ...PLAIN,
          loadPct: null,
          fillPct: null,
          dim: true,
          headline: g.hidden ? 'hidden' : 'suspended',
          facts: [{ label: 'State', value: g.hidden ? 'Hidden in Settings' : 'Suspended, not read' }],
        });
        continue;
      }
      const buf = bufferOf(n.busId);
      const tank = g ? gpuLayers(g, buf) : { layers: [], otherBytes: null };
      const vram = g ? `${formatBytes(g.vramUsedBytes)} / ${formatBytes(g.vramTotalBytes)}` : null;
      const fill = g ? pct(g.vramUsedBytes, g.vramTotalBytes) : null;
      add('Utilization', formatPct(g?.utilPct));
      add('VRAM', vram);
      if (buf && buf.modelBytes > 0) add('Model', formatBytes(buf.modelBytes));
      if (buf && buf.kvBytes > 0) add('KV cache', formatBytes(buf.kvBytes));
      if (buf && buf.computeBytes > 0) add('Compute buffers', formatBytes(buf.computeBytes));
      if (tank.otherBytes) add('Other VRAM', formatBytes(tank.otherBytes));
      if (g?.tempC != null) add('Temperature', `${fmt(g.tempC, 1)} °C`);
      if (g?.powerW != null) add('Power', `${fmt(g.powerW, 1)} W`);
      add('PCIe link', linkLabel(g?.pcieGen ?? link?.genCur, g?.pcieWidth ?? link?.widthCur));
      if (flow?.fwdBps != null) add('Host → GPU', formatBps(flow.fwdBps));
      if (flow?.backBps != null) add('GPU → host', formatBps(flow.backBps));
      const others = peers.find((group) => group.includes(n))?.filter((x) => x !== n);
      if (others) {
        const names = others.map((x) => x.label).join(', ');
        const p2p = placement?.p2p;
        add('Peer-to-peer', p2p === 'active' ? `active with ${names}` : P2P_SHORT[p2p ?? 'requested']);
      }
      out.set(n.id, {
        loadPct: g?.utilPct ?? null,
        fillPct: fill,
        fillLevel: levelOf(fill, FILL_WARN_PCT, FILL_CRIT_PCT),
        layers: tank.layers,
        cores: [],
        dim: false,
        headline: g?.utilPct != null ? formatPct(g.utilPct) : '—',
        barPct: g?.utilPct ?? null,
        sub: vram,
        facts,
      });
    } else if (n.kind === 'cpu') {
      const sys = snapshot?.system ?? null;
      add('Load', formatPct(sys?.cpuPct));
      if (snapshot?.proc) add('llama-server', formatPct(snapshot.proc.cpuPct));
      if (sys?.freqMhz != null) add('Frequency', `${sys.freqMhz} MHz`);
      if (sys?.tempC != null) add('Temperature', `${fmt(sys.tempC, 1)} °C`);
      const cores = n.detail.physicalCores;
      const threads = n.detail.logicalThreads;
      if (cores != null && threads != null) add('Cores', `${cores} cores · ${threads} threads`);
      if (n.detail.numaNodes != null)
        add('NUMA', `${n.detail.numaNodes} ${plural(Number(n.detail.numaNodes), 'node')}`);
      out.set(n.id, {
        ...PLAIN,
        loadPct: sys?.cpuPct ?? null,
        fillPct: null,
        cores: sys?.corePct ?? [],
        dim: false,
        headline: sys ? formatPct(sys.cpuPct) : '—',
        barPct: sys?.cpuPct ?? null,
        facts,
      });
    } else if (n.kind === 'ram') {
      const mem = snapshot?.system?.mem ?? null;
      const used = mem ? mem.totalBytes - mem.availableBytes : null;
      const host = placement ? placementTotals(placement).hostModelBytes : 0;
      const bw = snapshot?.system?.memBw ?? null;
      const usage = mem && used !== null ? `${formatBytes(used)} / ${formatBytes(mem.totalBytes)}` : null;
      add('Used', usage);
      if (bw) add('Read', formatBps(bw.readBps));
      if (bw) add('Write', formatBps(bw.writeBps));
      if (snapshot?.proc?.dramBps != null) add('llama-server (DRAM)', formatBps(snapshot.proc.dramBps));
      if (snapshot?.proc) add('llama-server (RSS)', formatBytes(snapshot.proc.rssBytes));
      if (host > 0) add('Model in RAM', formatBytes(host));
      if (mem && mem.swapTotalBytes > 0)
        add('Swap', `${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`);
      const dimms = n.detail.dimms;
      const temp = n.detail.tempC;
      if (dimms != null) add('DIMMs', temp != null ? `${dimms} · ${fmt(Number(temp), 1)} °C` : String(dimms));
      if (!bw) add('Bandwidth', 'not measured (perf): the link shows CPU activity');
      const fill = mem && used !== null ? pct(used, mem.totalBytes) : null;
      // One layer: weights mapped from the disk are page cache, which “used” leaves out, so no model layer here.
      out.set(n.id, {
        ...PLAIN,
        loadPct: fill,
        fillPct: fill,
        fillLevel: levelOf(fill, FILL_WARN_PCT, FILL_CRIT_PCT),
        layers: fill !== null ? [{ kind: 'used', pct: fill }] : [],
        dim: false,
        headline: usage ?? '—',
        facts,
      });
    } else if (n.kind === 'nvme') {
      const read = flow?.backBps ?? null;
      const write = flow?.fwdBps ?? null;
      const total = read === null && write === null ? null : (read ?? 0) + (write ?? 0);
      add('Read', read !== null ? formatBps(read) : null);
      add('Write', write !== null ? formatBps(write) : null);
      if (n.detail.sizeBytes != null) add('Capacity', formatBytes(Number(n.detail.sizeBytes)));
      add('PCIe link', linkLabel(link?.genCur, link?.widthCur));
      if (snapshot?.disk?.model?.disk === n.block) add('Role', 'Model disk');
      // No figure under the name: the link's badge carries the drive's throughput.
      out.set(n.id, {
        ...PLAIN,
        loadPct: total !== null && flow?.capacityBps ? pct(total, flow.capacityBps) : null,
        fillPct: null,
        dim: false,
        headline: null,
        facts,
      });
    } else {
      const kids = graph.links.filter((l) => l.from === n.id).length;
      const cur = linkLabel(link?.genCur, link?.widthCur);
      add('CPU link', cur && link ? `${cur} (max ${linkLabel(link.genMax, link.widthMax) ?? '—'})` : null);
      add('Devices', String(kids));
      out.set(n.id, { ...PLAIN, loadPct: null, fillPct: null, dim: false, headline: cur ?? '—', facts });
    }
  }
  return out;
}

/** A direct GPU-to-GPU connection (peer-to-peer): not a PCIe link of the graph, and not measured apart. */
export interface PeerLink {
  id: string;
  from: string;
  to: string;
  /** NCCL reports it in use; otherwise it is only requested by the launch, and may not be effective. */
  confirmed: boolean;
}

/** Backends that GGML_CUDA_P2P reaches: llama.cpp's CUDA code, which the ROCm backend shares. */
const P2P_BACKEND = /^(CUDA|ROCm)\d+$/;

/**
 * GPUs concerned by peer-to-peer, per backend: those holding the model when the launch requested it or NCCL reports
 * it, in the order of the scene. A backend with a single card has no one to talk to.
 */
function peerGroups(graph: TopologyGraph, placement: ModelPlacement | null): TopologyNode[][] {
  if (!placement?.p2p) return [];
  const groups = new Map<string, TopologyNode[]>();
  for (const n of graph.nodes) {
    if (n.kind !== 'gpu' || !n.busId) continue;
    const device = placement.buffers.find((b) => b.busId === n.busId)?.device;
    const backend = device ? P2P_BACKEND.exec(device)?.[1] : undefined;
    if (!backend) continue;
    const group = groups.get(backend) ?? [];
    group.push(n);
    groups.set(backend, group);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => (a.busId ?? '').localeCompare(b.busId ?? '')));
}

/**
 * Peer-to-peer links to draw: each group as a chain of neighbors (every pair exchanges, one line says it). None when
 * the driver refuses peer-to-peer: the cards then exchange through host memory, a link between them would be false.
 */
export function peerLinks(graph: TopologyGraph, placement: ModelPlacement | null): PeerLink[] {
  if (placement?.p2p === 'unavailable') return [];
  const confirmed = placement?.p2p === 'active';
  return peerGroups(graph, placement).flatMap((group) =>
    group.slice(1).map((to, i) => {
      const from = group[i]!;
      return { id: `p2p:${from.id}:${to.id}`, from: from.id, to: to.id, confirmed };
    }),
  );
}

/** Peer-to-peer of a GPU in its tooltip, when it is not in use (one short line: the Model card says more). */
const P2P_SHORT = {
  active: 'active',
  requested: 'requested, not confirmed',
  unavailable: 'refused by the driver',
} as const;

/** What the logs say about peer-to-peer, in words; null when it is neither requested nor reported. */
export function p2pSummary(placement: ModelPlacement | null): string | null {
  if (placement?.p2p === 'active') return 'active';
  if (placement?.p2p === 'unavailable') return 'requested, refused by the driver (through host memory)';
  if (placement?.p2p === 'requested') return 'requested, not confirmed';
  return null;
}

const TONES: Tone[] = ['blue', 'teal', 'amber', 'rose'];

/** Data tone of each GPU, by position in the graph (fixed order, see design-system). */
export function gpuTones(graph: TopologyGraph): Map<string, Tone> {
  const out = new Map<string, Tone>();
  let i = 0;
  for (const n of graph.nodes) if (n.kind === 'gpu') out.set(n.id, TONES[i++ % TONES.length]!);
  return out;
}

export interface PlacementSlice {
  label: string;
  bytes: number;
  /** Graph node hosting these bytes (GPU by busId, `ram` for the host); null if unknown. */
  nodeId: string | null;
}

/** Model split, GPUs in graph order then the host; empty without a placement. */
export function placementSeries(graph: TopologyGraph, placement: ModelPlacement | null): PlacementSlice[] {
  if (!placement) return [];
  const gpus = graph.nodes.filter((n) => n.kind === 'gpu');
  const order = (b: { busId: string | null }) => {
    const i = gpus.findIndex((n) => n.busId === b.busId);
    return i < 0 ? gpus.length : i;
  };
  const slices: PlacementSlice[] = placement.buffers
    .filter((b) => !hostDevice(b.device) && b.modelBytes > 0)
    .sort((a, b) => order(a) - order(b))
    .map((b) => ({ label: b.device, bytes: b.modelBytes, nodeId: gpus.find((n) => n.busId === b.busId)?.id ?? null }));
  const host = placementTotals(placement).hostModelBytes;
  if (host > 0) slices.push({ label: 'Host (RAM)', bytes: host, nodeId: 'ram' });
  return slices;
}
