import {
  type GpuSample,
  hostDevice,
  type ModelPlacement,
  pcieBps,
  placementTotals,
  type Snapshot,
  type TopologyGraph,
  type TopologyLink,
  type TopologyNode,
} from '@llama-webui/shared';
import type { Tone } from '@/components/glass/tones';
import { fmt, formatBps, formatBytes, formatPct, plural } from '@/lib/format';

/*
 * Projects the snapshot (existing measurements) onto the hardware graph: what flows over each link and what to say
 * about each node. Pure functions, tested without DOM or Three.
 */

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
}

export interface Fact {
  label: string;
  value: string;
}

export interface NodeLive {
  /** 0..100: load (GPU, CPU utilization…) driving the glow; null = unknown. */
  loadPct: number | null;
  /** 0..100: fill (VRAM, RAM); null = not applicable. */
  fillPct: number | null;
  /** Hidden or suspended card: dimmed, no values. */
  dim: boolean;
  /** Figure shown under the label. */
  headline: string;
  /** Tooltip lines. */
  facts: Fact[];
}

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

export function linkFlows(graph: TopologyGraph, snapshot: Snapshot | null): Map<string, LinkFlow> {
  const out = new Map<string, LinkFlow>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const perDisk = snapshot?.disk?.perDisk;

  const base = (l: TopologyLink, gen = l.genCur, width = l.widthCur): LinkFlow => ({
    fwdBps: null,
    backBps: null,
    activity: null,
    capacityBps: l.kind === 'pcie' ? pcieBps(gen ?? l.genMax, width ?? l.widthMax) : null,
    maxBps: l.kind === 'pcie' ? pcieBps(l.genMax, l.widthMax) : null,
  });

  const leaves = graph.links.filter((l) => byId.get(l.to)?.kind !== 'chipset');
  for (const l of leaves) {
    const to = byId.get(l.to);
    if (!to) continue;
    if (l.kind === 'memory') {
      // CPU → RAM: writes; RAM → CPU: reads (memory controller, everything included). Without perf: activity.
      const bw = snapshot?.system?.memBw ?? null;
      out.set(l.id, {
        ...base(l),
        fwdBps: bw ? bw.writeBps : null,
        backBps: bw ? bw.readBps : null,
        activity: bw ? null : cpuActivity(snapshot, byId.get(l.from)),
      });
    } else if (to.kind === 'gpu') {
      const g = gpuOf(snapshot, to);
      out.set(l.id, {
        ...base(l, g?.pcieGen ?? l.genCur, g?.pcieWidth ?? l.widthCur),
        fwdBps: g?.pcieRxBps ?? null,
        backBps: g?.pcieTxBps ?? null,
      });
    } else if (to.kind === 'nvme') {
      // This NVMe's block counters: CPU → NVMe for writes; NVMe → CPU for reads.
      const rates = to.block ? perDisk?.[to.block] : undefined;
      out.set(l.id, { ...base(l), fwdBps: rates?.writeBps ?? null, backBps: rates?.readBps ?? null });
    } else out.set(l.id, base(l));
  }
  // A chipset carries the sum of whatever sits behind it.
  for (const l of graph.links) {
    if (out.has(l.id)) continue;
    const behind = graph.links.filter((c) => c.from === l.to).map((c) => out.get(c.id));
    out.set(l.id, {
      ...base(l),
      fwdBps: sum(behind.map((f) => f?.fwdBps ?? null)),
      backBps: sum(behind.map((f) => f?.backBps ?? null)),
    });
  }
  return out;
}

const pct = (part: number, total: number) => (total > 0 ? (100 * part) / total : null);

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
          loadPct: null,
          fillPct: null,
          dim: true,
          headline: g.hidden ? 'hidden' : 'suspended',
          facts: [{ label: 'State', value: g.hidden ? 'Hidden in Settings' : 'Suspended, not read' }],
        });
        continue;
      }
      const buf = bufferOf(n.busId);
      add('Utilization', formatPct(g?.utilPct));
      if (g) add('VRAM', `${formatBytes(g.vramUsedBytes)} / ${formatBytes(g.vramTotalBytes)}`);
      if (buf && buf.modelBytes > 0) add('Model', formatBytes(buf.modelBytes));
      if (buf && buf.kvBytes > 0) add('KV cache', formatBytes(buf.kvBytes));
      if (g?.tempC != null) add('Temperature', `${fmt(g.tempC, 1)} °C`);
      if (g?.powerW != null) add('Power', `${fmt(g.powerW, 1)} W`);
      add('PCIe link', linkLabel(g?.pcieGen ?? link?.genCur, g?.pcieWidth ?? link?.widthCur));
      out.set(n.id, {
        loadPct: g?.utilPct ?? null,
        fillPct: g ? pct(g.vramUsedBytes, g.vramTotalBytes) : null,
        dim: false,
        headline: g?.utilPct != null ? formatPct(g.utilPct) : '—',
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
        loadPct: sys?.cpuPct ?? null,
        fillPct: null,
        dim: false,
        headline: sys ? formatPct(sys.cpuPct) : '—',
        facts,
      });
    } else if (n.kind === 'ram') {
      const mem = snapshot?.system?.mem ?? null;
      const used = mem ? mem.totalBytes - mem.availableBytes : null;
      const host = placement ? placementTotals(placement).hostModelBytes : 0;
      const bw = snapshot?.system?.memBw ?? null;
      if (mem && used !== null) add('Used', `${formatBytes(used)} / ${formatBytes(mem.totalBytes)}`);
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
      out.set(n.id, {
        loadPct: fill,
        fillPct: fill,
        dim: false,
        headline: bw ? formatBps(bw.readBps + bw.writeBps) : used !== null ? formatBytes(used) : '—',
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
      out.set(n.id, {
        loadPct: total !== null && flow?.capacityBps ? pct(total, flow.capacityBps) : null,
        fillPct: null,
        dim: false,
        headline: total !== null ? formatBps(total) : '—',
        facts,
      });
    } else {
      const kids = graph.links.filter((l) => l.from === n.id).length;
      const cur = linkLabel(link?.genCur, link?.widthCur);
      add('CPU link', cur && link ? `${cur} (max ${linkLabel(link.genMax, link.widthMax) ?? '—'})` : null);
      add('Devices', String(kids));
      out.set(n.id, { loadPct: null, fillPct: null, dim: false, headline: cur ?? '—', facts });
    }
  }
  return out;
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
