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
import { formatBps, formatBytes, formatPct } from '@/lib/format';

/*
 * Projection du snapshot (mesures existantes) sur le graphe matériel : ce qui circule sur chaque lien et ce qu'il faut
 * dire de chaque nœud. Fonctions pures, testées sans DOM ni Three.
 */

export interface LinkFlow {
  /**
   * Octets/s dans le sens du lien, amont → aval (`from` → `to`) : hôte → GPU, écritures CPU → RAM et CPU → NVMe ;
   * null = non mesurable.
   */
  fwdBps: number | null;
  /** Octets/s dans le sens aval → amont : GPU → hôte, lectures RAM → CPU et NVMe → CPU. */
  backBps: number | null;
  /**
   * Lien mémoire sans mesure perf : activité CPU en % de la machine (0–100), celle de llama-server ramenée au nombre de
   * threads, sinon celle de la machine, en guise de repli.
   */
  activity: number | null;
  /** Capacité du lien dans son état courant (Gen/largeur du moment) et au maximum ; null = inconnue. */
  capacityBps: number | null;
  maxBps: number | null;
}

export interface Fact {
  label: string;
  value: string;
}

export interface NodeLive {
  /** 0..100 : charge (utilisation GPU, CPU…) pilotant la lueur ; null = inconnue. */
  loadPct: number | null;
  /** 0..100 : remplissage (VRAM, RAM) ; null = sans objet. */
  fillPct: number | null;
  /** Carte masquée ou en veille : atténuée, sans valeurs. */
  dim: boolean;
  /** Chiffre affiché sous l'étiquette. */
  headline: string;
  /** Lignes de l'infobulle. */
  facts: Fact[];
}

const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const linkLabel = (gen: number | null | undefined, width: number | null | undefined) =>
  gen != null && width != null ? `Gen${gen} x${width}` : null;
const sum = (xs: (number | null)[]) => {
  const known = xs.filter((x): x is number => x !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

/** `proc.cpuPct` se compte en cœurs (jusqu'à N × 100) : ramené à la machine pour une échelle commune avec `system.cpuPct`. */
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
      // CPU → RAM : écritures ; RAM → CPU : lectures (contrôleur mémoire, tout compris). Sans perf : activité.
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
      // Compteurs du bloc de ce NVMe : CPU → NVMe, les écritures ; NVMe → CPU, les lectures.
      const rates = to.block ? perDisk?.[to.block] : undefined;
      out.set(l.id, { ...base(l), fwdBps: rates?.writeBps ?? null, backBps: rates?.readBps ?? null });
    } else out.set(l.id, base(l));
  }
  // Un chipset porte la somme de ce qui passe derrière lui.
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
  /** Débits déjà calculés par l'appelant pour ce snapshot (évite de les refaire). */
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
          headline: g.hidden ? 'masquée' : 'en veille',
          facts: [{ label: 'État', value: g.hidden ? 'Masquée (réglage hiddenGpus)' : 'En veille, non lue' }],
        });
        continue;
      }
      const buf = bufferOf(n.busId);
      add('Utilisation', formatPct(g?.utilPct));
      if (g) add('VRAM', `${formatBytes(g.vramUsedBytes)} / ${formatBytes(g.vramTotalBytes)}`);
      if (buf && buf.modelBytes > 0) add('Modèle', formatBytes(buf.modelBytes));
      if (buf && buf.kvBytes > 0) add('Cache KV', formatBytes(buf.kvBytes));
      if (g?.tempC != null) add('Température', `${nf1.format(g.tempC)} °C`);
      if (g?.powerW != null) add('Puissance', `${nf1.format(g.powerW)} W`);
      add('Lien PCIe', linkLabel(g?.pcieGen ?? link?.genCur, g?.pcieWidth ?? link?.widthCur));
      out.set(n.id, {
        loadPct: g?.utilPct ?? null,
        fillPct: g ? pct(g.vramUsedBytes, g.vramTotalBytes) : null,
        dim: false,
        headline: g?.utilPct != null ? formatPct(g.utilPct) : '—',
        facts,
      });
    } else if (n.kind === 'cpu') {
      const sys = snapshot?.system ?? null;
      add('Charge', formatPct(sys?.cpuPct));
      if (snapshot?.proc) add('llama-server', formatPct(snapshot.proc.cpuPct));
      if (sys?.freqMhz != null) add('Fréquence', `${sys.freqMhz} MHz`);
      if (sys?.tempC != null) add('Température', `${nf1.format(sys.tempC)} °C`);
      const cores = n.detail.physicalCores;
      const threads = n.detail.logicalThreads;
      if (cores != null && threads != null) add('Cœurs', `${cores} cœurs · ${threads} threads`);
      if (n.detail.numaNodes != null)
        add('NUMA', `${n.detail.numaNodes} nœud${Number(n.detail.numaNodes) > 1 ? 's' : ''}`);
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
      if (mem && used !== null) add('Utilisée', `${formatBytes(used)} / ${formatBytes(mem.totalBytes)}`);
      if (bw) add('Lecture', formatBps(bw.readBps));
      if (bw) add('Écriture', formatBps(bw.writeBps));
      if (snapshot?.proc?.dramBps != null) add('llama-server (DRAM)', formatBps(snapshot.proc.dramBps));
      if (snapshot?.proc) add('llama-server (RSS)', formatBytes(snapshot.proc.rssBytes));
      if (host > 0) add('Modèle en RAM', formatBytes(host));
      if (mem && mem.swapTotalBytes > 0)
        add('Swap', `${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`);
      const dimms = n.detail.dimms;
      const temp = n.detail.tempC;
      if (dimms != null) add('Barrettes', temp != null ? `${dimms} · ${nf1.format(Number(temp))} °C` : String(dimms));
      if (!bw) add('Bande passante', 'non mesurée (perf) : le lien montre l’activité CPU');
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
      add('Lecture', read !== null ? formatBps(read) : null);
      add('Écriture', write !== null ? formatBps(write) : null);
      if (n.detail.sizeBytes != null) add('Capacité', formatBytes(Number(n.detail.sizeBytes)));
      add('Lien PCIe', linkLabel(link?.genCur, link?.widthCur));
      if (snapshot?.disk?.model?.disk === n.block) add('Rôle', 'Disque du modèle');
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
      add('Liaison CPU', cur && link ? `${cur} (max ${linkLabel(link.genMax, link.widthMax) ?? '—'})` : null);
      add('Périphériques', String(kids));
      out.set(n.id, { loadPct: null, fillPct: null, dim: false, headline: cur ?? '—', facts });
    }
  }
  return out;
}

const TONES: Tone[] = ['blue', 'teal', 'amber', 'rose'];

/** Ton de données de chaque GPU, par position dans le graphe (ordre fixe, cf. design-system). */
export function gpuTones(graph: TopologyGraph): Map<string, Tone> {
  const out = new Map<string, Tone>();
  let i = 0;
  for (const n of graph.nodes) if (n.kind === 'gpu') out.set(n.id, TONES[i++ % TONES.length]!);
  return out;
}

export interface PlacementSlice {
  label: string;
  bytes: number;
  /** Nœud du graphe qui héberge ces octets (GPU par busId, `ram` pour l'hôte) ; null si inconnu. */
  nodeId: string | null;
}

/** Répartition du modèle, GPU dans l'ordre du graphe puis l'hôte ; vide sans placement. */
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
  if (host > 0) slices.push({ label: 'Hôte (RAM)', bytes: host, nodeId: 'ram' });
  return slices;
}
