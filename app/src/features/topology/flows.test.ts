import type { GpuP2pStatus, GpuSample, ModelPlacement, Snapshot, TopologyGraph } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import {
  detailOf,
  driverP2p,
  layerSlice,
  levelOf,
  linkBadge,
  linkFlows,
  linkShown,
  linkSpecs,
  nodeLive,
  peerBadge,
  peerFlows,
  p2pSummary,
  peerLinks,
  placementSeries,
} from './flows';
import { decodeLayerTarget, encodeLayerTarget } from './layerTooltip';

const graph: TopologyGraph = {
  at: 0,
  nodes: [
    { id: 'cpu', kind: 'cpu', label: 'Ryzen', detail: { physicalCores: 6, logicalThreads: 12, numaNodes: 1 } },
    { id: 'ram', kind: 'ram', label: 'Memory', detail: { totalBytes: 32 * 1024 ** 3, dimms: 2, tempC: 29.5 } },
    { id: 'pci:0000:01:00.0', kind: 'gpu', label: 'RTX 5070 Ti', busId: '0000:01:00.0', vendor: 'nvidia', detail: {} },
    { id: 'pci:0000:02:00.0', kind: 'nvme', label: 'Kingston', busId: '0000:02:00.0', block: 'nvme0n1', detail: {} },
    { id: 'chipset:0000:04:00.0', kind: 'chipset', label: '600 Series Chipset', busId: '0000:04:00.0', detail: {} },
    { id: 'pci:0000:08:00.0', kind: 'gpu', label: 'RX 9070', busId: '0000:08:00.0', vendor: 'amd', detail: {} },
    { id: 'pci:0000:0d:00.0', kind: 'gpu', label: '610M', busId: '0000:0d:00.0', vendor: 'amd', detail: {} },
  ],
  links: [
    {
      id: 'cpu-ram',
      from: 'cpu',
      to: 'ram',
      kind: 'memory',
      genMax: null,
      widthMax: null,
      genCur: null,
      widthCur: null,
    },
    { id: 'a', from: 'cpu', to: 'pci:0000:01:00.0', kind: 'pcie', genMax: 5, widthMax: 8, genCur: 1, widthCur: 8 },
    { id: 'b', from: 'cpu', to: 'pci:0000:02:00.0', kind: 'pcie', genMax: 4, widthMax: 4, genCur: 4, widthCur: 4 },
    { id: 'c', from: 'cpu', to: 'chipset:0000:04:00.0', kind: 'pcie', genMax: 4, widthMax: 4, genCur: 4, widthCur: 4 },
    {
      id: 'd',
      from: 'chipset:0000:04:00.0',
      to: 'pci:0000:08:00.0',
      kind: 'pcie',
      genMax: 4,
      widthMax: 4,
      genCur: 1,
      widthCur: 4,
    },
    {
      id: 'e',
      from: 'cpu',
      to: 'pci:0000:0d:00.0',
      kind: 'internal',
      genMax: null,
      widthMax: null,
      genCur: null,
      widthCur: null,
    },
  ],
};

const gpu = (o: Partial<GpuSample> & Pick<GpuSample, 'busId'>): GpuSample => ({
  key: `k:${o.busId}`,
  vendor: 'nvidia',
  name: 'GPU',
  utilPct: null,
  vramUsedBytes: 0,
  vramTotalBytes: 16 * 1024 ** 3,
  tempC: null,
  powerW: null,
  procVramBytes: 0,
  ...o,
});

const snapshot = {
  health: 'ok',
  rates: { genTps: 12.5, ppTps: 300 },
  slots: null,
  gpus: [],
  allGpus: [
    gpu({
      busId: '0000:01:00.0',
      utilPct: 80,
      vramUsedBytes: 12 * 1024 ** 3,
      tempC: 61,
      powerW: 220,
      pcieGen: 5,
      pcieWidth: 8,
      pcieRxBps: 2.5e9,
      pcieTxBps: 0.4e9,
    }),
    gpu({ busId: '0000:08:00.0', vendor: 'amd', utilPct: 35, vramUsedBytes: 11 * 1024 ** 3, pcieGen: 4, pcieWidth: 4 }),
    gpu({ busId: '0000:0d:00.0', vendor: 'amd', hidden: true }),
  ],
  proc: { cpuPct: 140, rssBytes: 3 * 1024 ** 3 },
  system: {
    cpuPct: 18,
    corePct: [],
    freqMhz: 4500,
    tempC: 52,
    load: null,
    mem: {
      totalBytes: 32 * 1024 ** 3,
      availableBytes: 20 * 1024 ** 3,
      cachedBytes: 0,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
  },
  // nvme0n1 holds the model; sda (SATA) adds its own traffic to the machine total.
  disk: {
    readBps: 900e6,
    writeBps: 25e6,
    perDisk: { nvme0n1: { readBps: 850e6, writeBps: 5e6 }, sda: { readBps: 50e6, writeBps: 20e6 } },
    model: { disk: 'nvme0n1', readBps: 850e6 },
  },
} as unknown as Snapshot;

const placement: ModelPlacement = {
  launchSeq: 0,
  layers: { offloaded: 49, total: 49 },
  buffers: [
    { device: 'CPU_Mapped', busId: null, modelBytes: 27e9, kvBytes: 0, computeBytes: 0 },
    { device: 'CUDA0', busId: '0000:01:00.0', modelBytes: 12e9, kvBytes: 80e6, computeBytes: 285e6 },
    { device: 'ROCm0', busId: '0000:08:00.0', modelBytes: 11e9, kvBytes: 80e6, computeBytes: 360e6 },
    { device: 'CUDA_Host', busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 64e6 },
  ],
};

test('linkFlows: GPU links carry NVML PCIe rates, host → GPU forward; capacity follows the current link state', () => {
  const f = linkFlows(graph, snapshot);
  expect(f.get('a')).toEqual({
    fwdBps: 2.5e9,
    backBps: 0.4e9,
    activity: null,
    capacityBps: 8 * 3.938e9,
    maxBps: 8 * 3.938e9,
    ratio: 2.5e9 / (8 * 3.938e9),
    level: 'ok',
  });
  // AMD: no rate in sysfs; the link is known, its traffic is not.
  expect(f.get('d')).toMatchObject({ fwdBps: null, backBps: null, capacityBps: 4 * 1.969e9 });
});

test('linkFlows: an NVMe link carries its own disk (writes forward, reads back); chipset sums what sits behind it; memory shows activity only', () => {
  const f = linkFlows(graph, snapshot);
  // Reads flow NVMe → CPU (back), writes CPU → NVMe (forward); the SATA disk's traffic is not on it.
  expect(f.get('b')).toMatchObject({ fwdBps: 5e6, backBps: 850e6, capacityBps: 4 * 1.969e9 });
  expect(f.get('c')).toMatchObject({ fwdBps: null, backBps: null }); // nothing measurable behind it
  expect(f.get('cpu-ram')).toMatchObject({ fwdBps: null, backBps: null, capacityBps: null });
  expect(f.get('e')).toMatchObject({ fwdBps: null, backBps: null, activity: null, capacityBps: null });
});

test('linkFlows: memory activity is a share of the whole machine (0–100), for llama-server as for the system', () => {
  // llama-server at 140% (1.4 cores) on the 12 threads of the CPU node.
  expect(linkFlows(graph, snapshot).get('cpu-ram')!.activity).toBeCloseTo(140 / 12, 5);
  // Thread count from the live per-core sample when there is one.
  const sampled = {
    ...snapshot,
    system: { ...snapshot.system, corePct: Array.from({ length: 16 }, () => 0) },
  } as Snapshot;
  expect(linkFlows(graph, sampled).get('cpu-ram')!.activity).toBeCloseTo(140 / 16, 5);
  // Every thread busy: 100, not 1200.
  const full = { ...snapshot, proc: { cpuPct: 1200, rssBytes: 0 } } as Snapshot;
  expect(linkFlows(graph, full).get('cpu-ram')!.activity).toBe(100);
  // No managed server: the machine's own load.
  expect(linkFlows(graph, { ...snapshot, proc: null }).get('cpu-ram')!.activity).toBe(18);
});

test('linkFlows / nodeLive: with perf, the memory link carries measured DRAM traffic (writes forward, reads back)', () => {
  const s = {
    ...snapshot,
    system: { ...snapshot.system, memBw: { readBps: 3e9, writeBps: 1e9 } },
    proc: { cpuPct: 140, rssBytes: 3 * 1024 ** 3, dramBps: 2.5e9 },
  } as Snapshot;
  expect(linkFlows(graph, s).get('cpu-ram')).toMatchObject({ fwdBps: 1e9, backBps: 3e9, activity: null });
  const ram = nodeLive(graph, s, placement).get('ram')!;
  // The label keeps the memory in use: the DRAM traffic is on the link's badge.
  expect(ram.headline).toBe('12.0 GiB / 32.0 GiB');
  expect(ram.facts.map((f) => f.label)).toEqual([
    'Used',
    'Read',
    'Write',
    'llama-server (DRAM)',
    'llama-server (RSS)',
    'Model in RAM',
    'DIMMs',
  ]);
});

test('linkFlows: without a snapshot every flow is unknown, capacities still known', () => {
  const f = linkFlows(graph, null);
  expect(f.get('a')).toMatchObject({ fwdBps: null, backBps: null, capacityBps: 8 * 0.25e9, maxBps: 8 * 3.938e9 });
  // The only NVMe, model elsewhere (SATA): its own rates, not the machine total.
  const s = {
    ...snapshot,
    disk: {
      ...snapshot.disk!,
      perDisk: { nvme0n1: { readBps: 0, writeBps: 1e6 }, sda: { readBps: 400e6, writeBps: 0 } },
    },
  } as Snapshot;
  expect(linkFlows(graph, s).get('b')).toMatchObject({ fwdBps: 1e6, backBps: 0 });
  // A disk the sampler does not know: unknown, not borrowed from the total.
  const unknown = { ...snapshot, disk: { ...snapshot.disk!, perDisk: {} } } as Snapshot;
  expect(linkFlows(graph, unknown).get('b')).toMatchObject({ fwdBps: null, backBps: null });
});

test('nodeLive: GPU facts, load and dimming', () => {
  const live = nodeLive(graph, snapshot, placement);
  const rtx = live.get('pci:0000:01:00.0')!;
  expect(rtx.loadPct).toBe(80);
  expect(rtx.fillPct).toBe(75);
  expect(rtx.dim).toBe(false);
  expect(rtx.headline).toBe('80%');
  expect(rtx.facts.map((f) => f.label)).toEqual([
    'Utilization',
    'VRAM',
    'Model',
    'KV cache',
    'Compute buffers',
    'Other VRAM',
    'Temperature',
    'Power',
    'PCIe link',
    'Host → GPU',
    'GPU → host',
  ]);
  expect(rtx.facts.find((f) => f.label === 'Model')!.value).toBe('11.2 GiB');
  expect(rtx.facts.find((f) => f.label === 'GPU → host')!.value).toBe('381.5 MiB/s');
  expect(rtx.facts.find((f) => f.label === 'PCIe link')!.value).toBe('Gen5 x8');

  const igpu = live.get('pci:0000:0d:00.0')!;
  expect(igpu.dim).toBe(true);
  expect(igpu.headline).toBe('hidden');
  expect(igpu.loadPct).toBeNull();
});

test('nodeLive: CPU, RAM, NVMe and chipset', () => {
  const live = nodeLive(graph, snapshot, placement);
  expect(live.get('cpu')).toMatchObject({ loadPct: 18, headline: '18%' });
  expect(live.get('cpu')!.facts.find((f) => f.label === 'llama-server')!.value).toBe('140%');
  const ram = live.get('ram')!;
  expect(ram.fillPct).toBe(37.5);
  expect(ram.facts.find((f) => f.label === 'Model in RAM')!.value).toBe('25.1 GiB');
  expect(ram.facts.find((f) => f.label === 'DIMMs')!.value).toBe('2 · 29.5 °C');
  // NVMe: reads and writes of its own disk.
  const nvme = live.get('pci:0000:02:00.0')!;
  expect(nvme.headline).toBeNull(); // its figures are on the link's badge
  expect(nvme.facts.filter((f) => f.label === 'Read' || f.label === 'Write').map((f) => f.value)).toEqual([
    '810.6 MiB/s',
    '4.8 MiB/s',
  ]);
  expect(nvme.facts.find((f) => f.label === 'Role')!.value).toBe('Model disk');
  expect(live.get('chipset:0000:04:00.0')).toMatchObject({ loadPct: null, headline: 'Gen4 x4' });
});

test('placementSeries: GPUs in graph order with their tone, host last, none when unknown', () => {
  const s = placementSeries(graph, placement);
  expect(s.map((x) => [x.label, x.bytes, x.nodeId])).toEqual([
    ['CUDA0', 12e9, 'pci:0000:01:00.0'],
    ['ROCm0', 11e9, 'pci:0000:08:00.0'],
    ['Host (RAM)', 27e9, 'ram'],
  ]);
  expect(placementSeries(graph, null)).toEqual([]);
});

const GIB = 1024 ** 3;
const withGpu = (o: Partial<GpuSample>): Snapshot => ({
  ...snapshot,
  allGpus: [{ ...snapshot.allGpus[0]!, ...o }, ...snapshot.allGpus.slice(1)],
});
const withDisk = (readBps: number, writeBps: number): Snapshot => ({
  ...snapshot,
  disk: { ...snapshot.disk!, perDisk: { nvme0n1: { readBps, writeBps } } },
});

test('levelOf: ok below the warning threshold, unknown is ok', () => {
  expect(levelOf(0.69, 0.7, 0.9)).toBe('ok');
  expect(levelOf(0.7, 0.7, 0.9)).toBe('warn');
  expect(levelOf(0.9, 0.7, 0.9)).toBe('crit');
  expect(levelOf(null, 0.7, 0.9)).toBe('ok');
});

test('linkFlows: saturation is the busier direction over the current capacity, amber from 70%, red from 90%', () => {
  const cap = 4 * 1.969e9; // Gen4 x4
  expect(linkFlows(graph, withDisk(0.5 * cap, 0.1 * cap)).get('b')).toMatchObject({ ratio: 0.5, level: 'ok' });
  expect(linkFlows(graph, withDisk(0.1 * cap, 0.75 * cap)).get('b')).toMatchObject({ ratio: 0.75, level: 'warn' });
  expect(linkFlows(graph, withDisk(0.95 * cap, 0)).get('b')).toMatchObject({ ratio: 0.95, level: 'crit' });
  // A link slowed down to Gen1 x8 saturates at 2 GB/s, not at its Gen5 maximum.
  const slow = linkFlows(graph, withGpu({ pcieGen: 1, pcieWidth: 8, pcieRxBps: 1.9e9, pcieTxBps: 0 })).get('a')!;
  expect(slow.ratio).toBeCloseTo(0.95, 6);
  expect(slow.level).toBe('crit');
  // Unmeasured traffic or unknown capacity: no ratio, never an alert.
  const f = linkFlows(graph, snapshot);
  expect(f.get('d')).toMatchObject({ ratio: null, level: 'ok' });
  expect(f.get('cpu-ram')).toMatchObject({ ratio: null, level: 'ok' });
});

test('linkFlows: a chipset link is measured against its own uplink, with the sum of what sits behind it', () => {
  const g: TopologyGraph = {
    ...graph,
    nodes: [...graph.nodes, { id: 'pci:0000:09:00.0', kind: 'nvme', label: 'WD', block: 'nvme1n1', detail: {} }],
    links: [
      ...graph.links,
      {
        id: 'f',
        from: 'chipset:0000:04:00.0',
        to: 'pci:0000:09:00.0',
        kind: 'pcie',
        genMax: 4,
        widthMax: 4,
        genCur: 4,
        widthCur: 4,
      },
    ],
  };
  const cap = 4 * 1.969e9;
  const s = {
    ...snapshot,
    disk: { ...snapshot.disk!, perDisk: { nvme1n1: { readBps: 0.8 * cap, writeBps: 0 } } },
  } as Snapshot;
  expect(linkFlows(g, s).get('c')).toMatchObject({ backBps: 0.8 * cap, ratio: 0.8, level: 'warn' });
});

test('linkBadge: both directions in the words of each kind of link, nothing at rest under 8 MiB/s, nothing without a measurement', () => {
  const badge = (g: TopologyGraph, s: Snapshot | null, id: string, busy = false) => {
    const link = g.links.find((l) => l.id === id)!;
    return linkBadge(
      link,
      g.nodes.find((n) => n.id === link.to)!,
      linkFlows(g, s).get(id)!,
      busy,
    );
  };
  expect(badge(graph, snapshot, 'a')).toEqual({
    lines: [
      { label: '→ GPU', value: '2.3 GiB/s' },
      { label: '→ host', value: '381.5 MiB/s' },
    ],
    pct: null, // 8% of the link: not worth a figure
    level: 'ok',
  });
  expect(badge(graph, snapshot, 'b')!.lines).toEqual([
    { label: 'read', value: '810.6 MiB/s' },
    { label: 'write', value: '4.8 MiB/s' },
  ]);
  const perf = { ...snapshot, system: { ...snapshot.system, memBw: { readBps: 3e9, writeBps: 1e9 } } } as Snapshot;
  expect(badge(graph, perf, 'cpu-ram')).toEqual({
    lines: [
      { label: 'read', value: '2.8 GiB/s' },
      { label: 'write', value: '953.7 MiB/s' },
    ],
    pct: null,
    level: 'ok',
  });
  // The share of the capacity is written out from 25%, with its level.
  const cap = 4 * 1.969e9;
  expect(badge(graph, withDisk(0.87 * cap, 0), 'b')).toMatchObject({ pct: '87%', level: 'warn' });
  expect(badge(graph, withDisk(0.3 * cap, 0), 'b')).toMatchObject({ pct: '30%', level: 'ok' });
  expect(badge(graph, withDisk(0.2 * cap, 0), 'b')).toMatchObject({ pct: null });
  // Idle, unmeasured (AMD GPU, memory without perf, chipset with nothing measured behind) or internal: no badge.
  // At rest, background traffic gets no badge; while llama-server works, every link that carries streaks has one.
  expect(badge(graph, withDisk(8e6, 3e6), 'b')).toBeNull();
  expect(badge(graph, withDisk(9e6, 20e3), 'b')).not.toBeNull();
  expect(badge(graph, withDisk(8e6, 3e6), 'b', true)!.lines.map((l) => l.value)).toEqual(['7.6 MiB/s', '2.9 MiB/s']);
  expect(badge(graph, withDisk(90e3, 20e3), 'b', true)).toBeNull();
  expect(badge(graph, snapshot, 'd', true)).toBeNull();
  expect(badge(graph, snapshot, 'd')).toBeNull();
  expect(badge(graph, snapshot, 'cpu-ram')).toBeNull();
  expect(badge(graph, snapshot, 'c')).toBeNull();
  expect(badge(graph, snapshot, 'e')).toBeNull();
  expect(badge(graph, null, 'a')).toBeNull();
});

test('linkBadge: a chipset link speaks of the devices behind it', () => {
  const g: TopologyGraph = {
    ...graph,
    nodes: [...graph.nodes, { id: 'pci:0000:09:00.0', kind: 'nvme', label: 'WD', block: 'nvme1n1', detail: {} }],
    links: [
      ...graph.links,
      {
        id: 'f',
        from: 'chipset:0000:04:00.0',
        to: 'pci:0000:09:00.0',
        kind: 'pcie',
        genMax: 4,
        widthMax: 4,
        genCur: 4,
        widthCur: 4,
      },
    ],
  };
  const s = {
    ...snapshot,
    disk: { ...snapshot.disk!, perDisk: { nvme1n1: { readBps: 2e9, writeBps: 1e6 } } },
  } as Snapshot;
  const link = g.links.find((l) => l.id === 'c')!;
  expect(
    linkBadge(
      link,
      g.nodes.find((n) => n.id === link.to)!,
      linkFlows(g, s).get('c')!,
      false,
    )!.lines,
  ).toEqual([
    { label: '→ devices', value: '976.6 KiB/s' },
    { label: '→ host', value: '1.9 GiB/s' },
  ]);
});

test('nodeLive: a GPU tank is filled to the measured VRAM, split by what the logs say it holds', () => {
  const rtx = nodeLive(graph, snapshot, placement).get('pci:0000:01:00.0')!;
  const total = 16 * GIB;
  expect(rtx.layers.map((l) => l.kind)).toEqual(['model', 'kv', 'compute', 'other']);
  expect(rtx.layers[0]!.pct).toBeCloseTo((100 * 12e9) / total, 6);
  expect(rtx.layers[1]!.pct).toBeCloseTo((100 * 80e6) / total, 6);
  expect(rtx.layers[2]!.pct).toBeCloseTo((100 * 285e6) / total, 6);
  expect(rtx.layers[3]!.pct).toBeCloseTo((100 * (12 * GIB - 12.365e9)) / total, 6);
  expect(rtx.layers.reduce((s, l) => s + l.pct, 0)).toBeCloseTo(75, 6); // = the measured fill
  expect(rtx).toMatchObject({ headline: '80%', barPct: 80, sub: '12.0 GiB / 16.0 GiB', fillLevel: 'ok' });
  expect(rtx.facts.find((f) => f.label === 'Compute buffers')!.value).toBe('271.8 MiB');
  expect(rtx.facts.find((f) => f.label === 'Other VRAM')!.value).toBe('495.8 MiB');
});

test('nodeLive: the measured VRAM wins over the sizes announced by the logs (loading, tensor estimate)', () => {
  // The logs announce 12.4 GB while 4 GiB are allocated so far: the layers shrink together, there is no “other”.
  const loading = nodeLive(graph, withGpu({ vramUsedBytes: 4 * GIB }), placement).get('pci:0000:01:00.0')!;
  expect(loading.layers.reduce((s, l) => s + l.pct, 0)).toBeCloseTo(25, 6);
  expect(loading.layers[0]!.pct / loading.layers[1]!.pct).toBeCloseTo(12e9 / 80e6, 6);
  expect(loading.layers[3]).toEqual({ kind: 'other', pct: 0, bytes: 0 });
  expect(loading.facts.some((f) => f.label === 'Other VRAM')).toBe(false);
});

test('nodeLive: without a known split a GPU tank has one layer; a hidden GPU has none', () => {
  const live = nodeLive(graph, snapshot, null);
  expect(live.get('pci:0000:01:00.0')!.layers).toEqual([{ kind: 'used', pct: 75, bytes: 12 * GIB }]);
  expect(live.get('pci:0000:0d:00.0')).toMatchObject({ layers: [], barPct: null, sub: null, fillLevel: 'ok' });
  // No sample yet: an empty tank, not a broken one.
  expect(nodeLive(graph, null, placement).get('pci:0000:01:00.0')).toMatchObject({ layers: [], headline: '—' });
});

test('nodeLive: tank alerts from 85% and 95% full', () => {
  const at = (bytes: number) => nodeLive(graph, withGpu({ vramUsedBytes: bytes }), null).get('pci:0000:01:00.0')!;
  expect(at(13 * GIB).fillLevel).toBe('ok');
  expect(at(14 * GIB).fillLevel).toBe('warn');
  expect(at(15.5 * GIB).fillLevel).toBe('crit');
});

test('nodeLive: memory is a single layer (mapped weights are page cache), the CPU carries its threads', () => {
  const live = nodeLive(graph, snapshot, placement);
  expect(live.get('ram')).toMatchObject({
    layers: [{ kind: 'used', pct: 37.5, bytes: 12 * GIB }],
    headline: '12.0 GiB / 32.0 GiB',
    barPct: null,
    fillLevel: 'ok',
  });
  expect(live.get('cpu')).toMatchObject({ barPct: 18, cores: [], layers: [] });
  const sampled = { ...snapshot, system: { ...snapshot.system, corePct: [100, 0, 35.5, 2] } } as Snapshot;
  expect(nodeLive(graph, sampled, placement).get('cpu')!.cores).toEqual([100, 0, 35.5, 2]);
  expect(live.get('pci:0000:02:00.0')).toMatchObject({ layers: [], barPct: null });
});

/** Two NVIDIA cards and an AMD one in the model, as -dev CUDA0,CUDA1,ROCm0 would load it. */
const threeGpus: TopologyGraph = {
  ...graph,
  nodes: [
    ...graph.nodes,
    { id: 'pci:0000:03:00.0', kind: 'gpu', label: 'RTX 5060 Ti', busId: '0000:03:00.0', vendor: 'nvidia', detail: {} },
  ],
};
const ALL: [string, string | null][] = [
  ['CUDA0', '0000:01:00.0'],
  ['CUDA1', '0000:03:00.0'],
  ['ROCm0', '0000:08:00.0'],
];
const split = (p2p: ModelPlacement['p2p'], devices = ALL): ModelPlacement => ({
  launchSeq: 0,
  layers: null,
  buffers: devices.map(([device, busId]) => ({ device, busId, modelBytes: 4e9, kvBytes: 0, computeBytes: 0 })),
  ...(p2p && { p2p }),
});

test('peerLinks: the GPUs of one backend that hold the model are joined when peer-to-peer is requested or reported', () => {
  const id = 'p2p:pci:0000:01:00.0:pci:0000:03:00.0';
  expect(peerLinks(threeGpus, split('requested'))).toEqual([
    { id, from: 'pci:0000:01:00.0', to: 'pci:0000:03:00.0', confirmed: false },
  ]);
  expect(peerLinks(threeGpus, split('active'))).toEqual([
    { id, from: 'pci:0000:01:00.0', to: 'pci:0000:03:00.0', confirmed: true },
  ]);
  // Refused by the driver: the cards exchange through host memory, no link between them.
  expect(peerLinks(threeGpus, split('unavailable'))).toEqual([]);
  // Not requested, or no placement: no link.
  expect(peerLinks(threeGpus, split(undefined))).toEqual([]);
  expect(peerLinks(threeGpus, null)).toEqual([]);
});

test('peerLinks: a single GPU per backend or a device without a PCI address: nothing to join', () => {
  expect(
    peerLinks(
      threeGpus,
      split('active', [
        ['CUDA0', '0000:01:00.0'],
        ['ROCm0', '0000:08:00.0'],
      ]),
    ),
  ).toEqual([]);
  expect(
    peerLinks(
      threeGpus,
      split('active', [
        ['CUDA0', '0000:01:00.0'],
        ['CUDA1', null],
      ]),
    ),
  ).toEqual([]);
  // Vulkan has no peer-to-peer in llama.cpp: GGML_CUDA_P2P only reaches the CUDA and ROCm backends.
  expect(
    peerLinks(
      threeGpus,
      split('requested', [
        ['Vulkan0', '0000:01:00.0'],
        ['Vulkan1', '0000:03:00.0'],
      ]),
    ),
  ).toEqual([]);
});

test('peerLinks: three cards of one backend are joined as a chain, by bus address', () => {
  const g: TopologyGraph = {
    ...threeGpus,
    nodes: [
      ...threeGpus.nodes,
      { id: 'pci:0000:05:00.0', kind: 'gpu', label: 'RTX 4090', busId: '0000:05:00.0', vendor: 'nvidia', detail: {} },
    ],
  };
  const links = peerLinks(
    g,
    split('active', [
      ['CUDA2', '0000:05:00.0'],
      ['CUDA0', '0000:01:00.0'],
      ['CUDA1', '0000:03:00.0'],
    ]),
  );
  expect(links.map((l) => [l.from, l.to])).toEqual([
    ['pci:0000:01:00.0', 'pci:0000:03:00.0'],
    ['pci:0000:03:00.0', 'pci:0000:05:00.0'],
  ]);
});

test('nodeLive: a GPU says what is known of its peer-to-peer, and with which cards', () => {
  const p2p = (status: ModelPlacement['p2p'], id = 'pci:0000:01:00.0') =>
    nodeLive(threeGpus, snapshot, split(status))
      .get(id)!
      .facts.find((f) => f.label === 'Peer-to-peer')?.value;
  expect(p2p('active')).toBe('active with RTX 5060 Ti');
  expect(p2p('requested')).toBe('requested, not confirmed');
  expect(p2p('unavailable')).toBe('refused by the driver');
  expect(p2p(undefined)).toBeUndefined();
  // The AMD card is alone on its backend.
  expect(p2p('active', 'pci:0000:08:00.0')).toBeUndefined();
});

/** The two NVIDIA cards each on a root port of the CPU, resting in Gen1, and the AMD card behind the chipset. */
const wired: TopologyGraph = {
  ...threeGpus,
  links: [
    ...threeGpus.links,
    { id: 'f', from: 'cpu', to: 'pci:0000:03:00.0', kind: 'pcie', genMax: 5, widthMax: 8, genCur: 1, widthCur: 8 },
  ],
};
const MIB = 1024 ** 2;
/** What the two NVIDIA cards exchange, as each one counts it: `[rx, tx]` of 01:00.0 then of 03:00.0. */
const exchanging = (a: [number, number] | null, b: [number, number] | null) =>
  ({
    ...snapshot,
    allGpus: [
      gpu({ busId: '0000:01:00.0', ...(a && { pcieRxBps: a[0], pcieTxBps: a[1] }) }),
      gpu({ busId: '0000:03:00.0', ...(b && { pcieRxBps: b[0], pcieTxBps: b[1] }) }),
    ],
  }) as Snapshot;
const busySnapshot = exchanging([800 * MIB, 950 * MIB], [900 * MIB, 1000 * MIB]);
const PEER = 'p2p:pci:0000:01:00.0:pci:0000:03:00.0';
const flowsOf = (g: TopologyGraph, s: Snapshot | null, p2p: ModelPlacement['p2p'] = 'active') =>
  peerFlows(g, peerLinks(g, split(p2p)), linkFlows(g, s));

test('peerFlows: each direction is at most what one card sends and the other receives', () => {
  const flow = flowsOf(wired, busySnapshot).get(PEER)!;
  // 01:00.0 sends 950 and 03:00.0 receives 900; back, 1000 sent and 800 received.
  expect(flow.fwdBps).toBe(900 * MIB);
  expect(flow.backBps).toBe(800 * MIB);
  // A card without a sample, or a link without its card in the graph: nothing to estimate.
  expect(flowsOf(wired, exchanging([800 * MIB, 950 * MIB], null)).get(PEER)).toMatchObject({
    fwdBps: null,
    backBps: null,
  });
  expect(flowsOf(wired, null).get(PEER)).toMatchObject({ fwdBps: null, backBps: null });
});

test('peerFlows: the capacity is the slowest link of the path at its most, whatever the links rest at', () => {
  // Both links rest in Gen1 x8 and train up to Gen5 x8.
  expect(flowsOf(wired, busySnapshot).get(PEER)!.capacityBps).toBe(8 * 3.938e9);
  expect(flowsOf(wired, null).get(PEER)!.capacityBps).toBe(8 * 3.938e9);
  // A card behind the chipset: its own link and the chipset's are on the way (Gen4 x4), not only the two cards'.
  const behind = { id: 'x', from: 'pci:0000:01:00.0', to: 'pci:0000:08:00.0', confirmed: true };
  expect(peerFlows(wired, [behind], linkFlows(wired, null)).get('x')!.capacityBps).toBe(4 * 1.969e9);
  // A card no link reaches (threeGpus leaves 03:00.0 unwired): the one link that is known.
  expect(flowsOf(threeGpus, null).get(PEER)!.capacityBps).toBe(8 * 3.938e9);
  const loose = { id: 'y', from: 'pci:0000:03:00.0', to: 'pci:0000:0d:00.0', confirmed: true };
  expect(peerFlows(threeGpus, [loose], linkFlows(threeGpus, null)).get('y')!.capacityBps).toBeNull();
});

test('peerFlows: nothing for a link that is only requested, its traffic may go through the host', () => {
  expect(flowsOf(wired, busySnapshot, 'requested').size).toBe(0);
  expect(flowsOf(wired, busySnapshot, 'unavailable').size).toBe(0);
});

test('peerBadge: the capacity of the path, and each direction named after the card it reaches', () => {
  const [peer] = peerLinks(wired, split('active'));
  const flow = flowsOf(wired, busySnapshot).get(PEER);
  expect(peerBadge(wired, peer!, flow, true)).toEqual({
    title: 'P2P',
    capacity: 'up to 29.3 GiB/s',
    lines: [
      { label: '→ 5060 Ti', value: '≈ 900.0 MiB/s' },
      { label: '→ 5070 Ti', value: '≈ 800.0 MiB/s' },
    ],
  });
  // At rest the traffic under 8 MiB/s is not shown, like on the other links; the capacity stays.
  const idle = flowsOf(wired, exchanging([2 * MIB, 3 * MIB], [MIB, 2 * MIB])).get(PEER);
  expect(peerBadge(wired, peer!, idle, false)).toEqual({ title: 'P2P', capacity: 'up to 29.3 GiB/s', lines: [] });
  expect(peerBadge(wired, peer!, idle, true).lines).toHaveLength(2);
  expect(peerBadge(wired, peer!, undefined, true)).toEqual({ title: 'P2P', capacity: null, lines: [] });
  // Only requested: said as before, without figures.
  const [asked] = peerLinks(wired, split('requested'));
  expect(peerBadge(wired, asked!, undefined, true)).toEqual({ title: 'P2P requested', capacity: null, lines: [] });
});

test('peerBadge: two cards of the same name are told apart by their bus address', () => {
  const twins: TopologyGraph = {
    ...wired,
    nodes: wired.nodes.map((n) => (n.kind === 'gpu' && n.vendor === 'nvidia' ? { ...n, label: 'RTX 5090' } : n)),
  };
  const [peer] = peerLinks(twins, split('active'));
  const flow = flowsOf(twins, busySnapshot).get(PEER);
  expect(peerBadge(twins, peer!, flow, true).lines.map((l) => l.label)).toEqual(['→ 03:00.0', '→ 01:00.0']);
});

test('nodeLive: a card in active peer-to-peer lists what it exchanges with the other, and the path between them', () => {
  const facts = (status: ModelPlacement['p2p'], id = 'pci:0000:01:00.0') =>
    nodeLive(wired, busySnapshot, split(status))
      .get(id)!
      .facts.filter((f) => f.label.startsWith('P2P'));
  expect(facts('active')).toEqual([
    { label: 'P2P → 5060 Ti', value: '≈ 900.0 MiB/s' },
    { label: 'P2P ← 5060 Ti', value: '≈ 800.0 MiB/s' },
    { label: 'P2P path', value: 'up to 29.3 GiB/s' },
  ]);
  expect(facts('active', 'pci:0000:03:00.0')).toEqual([
    { label: 'P2P → 5070 Ti', value: '≈ 800.0 MiB/s' },
    { label: 'P2P ← 5070 Ti', value: '≈ 900.0 MiB/s' },
    { label: 'P2P path', value: 'up to 29.3 GiB/s' },
  ]);
  expect(facts('requested')).toEqual([]);
  expect(facts('active', 'pci:0000:08:00.0')).toEqual([]);
});

/** The two NVIDIA cards with the driver's answer for peer-to-peer from each one to the other. */
const allowing = (there: GpuP2pStatus | null, back: GpuP2pStatus | null = there): Snapshot => ({
  ...busySnapshot,
  allGpus: [
    gpu({ busId: '0000:01:00.0', ...(there && { p2p: [{ busId: '0000:03:00.0', status: there }] }) }),
    gpu({ busId: '0000:03:00.0', ...(back && { p2p: [{ busId: '0000:01:00.0', status: back }] }) }),
  ],
});
const NVIDIA = split('requested', [
  ['CUDA0', '0000:01:00.0'],
  ['CUDA1', '0000:03:00.0'],
]);

test('peerLinks: the driver confirms or refuses a link the launch only requested', () => {
  const linksOf = (s: Snapshot, launch = NVIDIA) => peerLinks(wired, launch, driverP2p(s));
  expect(linksOf(allowing('ok'))).toEqual([
    { id: PEER, from: 'pci:0000:01:00.0', to: 'pci:0000:03:00.0', confirmed: true },
  ]);
  // Refused in one direction is refused: the cards exchange through host memory, no link.
  expect(linksOf(allowing('ok', 'gpu'))).toEqual([]);
  expect(linksOf(allowing('chipset'))).toEqual([]);
  // One answer of two, or none (nvidia-smi, a hidden card): still only requested.
  expect(linksOf(allowing('ok', null))).toMatchObject([{ confirmed: false }]);
  expect(linksOf(allowing(null))).toMatchObject([{ confirmed: false }]);
  // What NCCL logged comes first, and the driver alone draws nothing.
  expect(linksOf(allowing('gpu'), { ...NVIDIA, p2p: 'active' })).toMatchObject([{ confirmed: true }]);
  expect(linksOf(allowing('ok'), { ...NVIDIA, p2p: 'unavailable' })).toEqual([]);
  const { p2p: _, ...unasked } = NVIDIA;
  expect(linksOf(allowing('ok'), unasked)).toEqual([]);
});

test('p2pSummary: says where the word comes from, the logs or the driver', () => {
  const summary = (s: Snapshot, launch: ModelPlacement | null = NVIDIA) => p2pSummary(launch, wired, driverP2p(s));
  expect(summary(allowing('ok'))).toBe('active (requested, and the driver allows it)');
  expect(summary(allowing('gpu'))).toBe('requested, refused by the driver (card not supported; through host memory)');
  expect(summary(allowing(null))).toBe('requested, not confirmed');
  expect(summary(allowing('gpu'), { ...NVIDIA, p2p: 'active' })).toBe('active');
  expect(summary(allowing('ok'), { ...NVIDIA, p2p: 'unavailable' })).toBe(
    'requested, refused by the driver (through host memory)',
  );
  expect(summary(allowing('ok'), null)).toBeNull();
  expect(p2pSummary(NVIDIA)).toBe('requested, not confirmed');
});

test('nodeLive: a launch that requested peer-to-peer takes the word of the driver, and its figures with it', () => {
  const facts = (s: Snapshot) =>
    nodeLive(wired, s, NVIDIA)
      .get('pci:0000:01:00.0')!
      .facts.filter((f) => /P2P|[Pp]eer-to-peer/.test(f.label));
  expect(facts(allowing('ok'))).toEqual([
    { label: 'Peer-to-peer', value: 'active with RTX 5060 Ti' },
    { label: 'P2P path', value: 'up to 29.3 GiB/s' },
  ]);
  expect(facts(allowing('disabled'))).toEqual([{ label: 'Peer-to-peer', value: 'refused by the driver' }]);
  expect(facts(allowing(null))).toEqual([{ label: 'Peer-to-peer', value: 'requested, not confirmed' }]);
});

test('nodeLive: without a launch that concerns it, a card says what the driver would allow', () => {
  const facts = (s: Snapshot, id = 'pci:0000:01:00.0') =>
    nodeLive(wired, s, null)
      .get(id)!
      .facts.filter((f) => /[Pp]eer-to-peer/.test(f.label));
  expect(facts(allowing('ok'))).toEqual([{ label: 'Peer-to-peer', value: 'allowed by the driver with RTX 5060 Ti' }]);
  expect(facts(allowing('ok', 'topology'))).toEqual([
    { label: 'No peer-to-peer with RTX 5060 Ti', value: 'PCI topology not supported' },
  ]);
  expect(facts(allowing(null))).toEqual([]);
  expect(facts(allowing('ok'), 'pci:0000:08:00.0')).toEqual([]);
});

test('linkShown: at rest only from 8 MiB/s in the busier direction, from 100 kB/s while llama-server works', () => {
  const mib = 1024 ** 2;
  expect(linkShown({ fwdBps: 4 * mib, backBps: mib }, false)).toBe(false);
  expect(linkShown({ fwdBps: 0, backBps: 8 * mib }, false)).toBe(true);
  expect(linkShown({ fwdBps: 4 * mib, backBps: null }, true)).toBe(true);
  expect(linkShown({ fwdBps: 50e3, backBps: 50e3 }, true)).toBe(false);
  expect(linkShown({ fwdBps: null, backBps: null }, true)).toBe(false);
});

const withRtx = (o: Partial<GpuSample>): Snapshot => ({
  ...snapshot,
  allGpus: snapshot.allGpus.map((g) => (g.busId === '0000:01:00.0' ? { ...g, ...o } : g)),
});
const factsOf = (s: Snapshot, id: string) =>
  Object.fromEntries(
    nodeLive(graph, s, placement)
      .get(id)!
      .facts.map((f) => [f.label, f.value]),
  );

test('nodeLive: the detail of a GPU adds what the sample carries beyond the essentials', () => {
  const s = withRtx({
    procVramBytes: 11 * 1024 ** 3,
    memUtilPct: 42,
    fanPct: 55,
    powerLimitW: 250,
    powerDefaultLimitW: 300,
    clockGrMhz: 2520,
    clockMemMhz: 15001,
  });
  const live = nodeLive(graph, s, placement).get('pci:0000:01:00.0')!;
  expect(live.facts.map((f) => f.label)).toEqual([
    'Utilization',
    'VRAM',
    'Model',
    'KV cache',
    'Compute buffers',
    'Other VRAM',
    'llama-server (VRAM)',
    'Temperature',
    'Power',
    'Memory controller',
    'Fan',
    'Power limit',
    'Graphics clock',
    'Memory clock',
    'PCIe link',
    'Host → GPU',
    'GPU → host',
  ]);
  expect(factsOf(s, 'pci:0000:01:00.0')).toMatchObject({
    'llama-server (VRAM)': '11.0 GiB',
    'Memory controller': '42%',
    Fan: '55%',
    'Power limit': '250 W (factory 300 W)',
    'Graphics clock': '2,520 MHz',
    'Memory clock': '15,001 MHz',
  });
});

test('nodeLive: a power limit left at the factory value is written once', () => {
  const s = withRtx({ powerLimitW: 300, powerDefaultLimitW: 300 });
  expect(factsOf(s, 'pci:0000:01:00.0')['Power limit']).toBe('300 W');
  expect(factsOf(withRtx({ powerLimitW: 300 }), 'pci:0000:01:00.0')['Power limit']).toBe('300 W');
});

test('nodeLive: a detail row is absent when the sample does not have its value', () => {
  const labels = Object.keys(factsOf(snapshot, 'pci:0000:01:00.0'));
  for (const label of [
    'llama-server (VRAM)',
    'Memory controller',
    'Fan',
    'Power limit',
    'Graphics clock',
    'Memory clock',
  ])
    expect(labels).not.toContain(label);
  expect(Object.keys(factsOf(snapshot, 'cpu'))).not.toContain('Load average');
  expect(Object.keys(factsOf(snapshot, 'ram'))).not.toContain('Cached');
});

test('nodeLive: the CPU gives its load average and the memory its page cache', () => {
  const s = {
    ...snapshot,
    system: {
      ...snapshot.system,
      load: [1.5, 0.75, 0.25],
      mem: { ...snapshot.system!.mem, cachedBytes: 6 * 1024 ** 3 },
    },
  } as Snapshot;
  const cpu = nodeLive(graph, s, placement)
    .get('cpu')!
    .facts.map((f) => f.label);
  expect(cpu.slice(cpu.indexOf('Temperature'), cpu.indexOf('Temperature') + 2)).toEqual([
    'Temperature',
    'Load average',
  ]);
  expect(factsOf(s, 'cpu')['Load average']).toBe('1.50  0.75  0.25');
  const ram = nodeLive(graph, s, placement)
    .get('ram')!
    .facts.map((f) => f.label);
  expect(ram.slice(0, 2)).toEqual(['Used', 'Cached']);
  expect(factsOf(s, 'ram').Cached).toBe('6.0 GiB');
});

test('nodeLive: a GPU inside the processor has no PCIe link among its facts, whatever its sample says', () => {
  const s = {
    ...snapshot,
    allGpus: [
      ...snapshot.allGpus.filter((g) => g.busId !== '0000:0d:00.0'),
      gpu({ busId: '0000:0d:00.0', vendor: 'amd', pcieGen: 4, pcieWidth: 16, tempC: 34 }),
    ],
  } as Snapshot;
  const labels = nodeLive(graph, s, placement)
    .get('pci:0000:0d:00.0')!
    .facts.map((f) => f.label);
  expect(labels).toContain('Temperature');
  expect(labels).not.toContain('PCIe link');
});

test('nodeLive: a card in a slot gives the lanes its link trained at, a GPU sample winning over the graph', () => {
  const live = nodeLive(graph, snapshot, placement);
  expect(live.get('pci:0000:01:00.0')!.lanes).toBe(8);
  expect(live.get('pci:0000:08:00.0')!.lanes).toBe(4);
  // Without a sample, what the graph read; without a current state, what the link can do
  const wide = {
    ...graph,
    links: graph.links.map((l) => (l.id === 'a' ? { ...l, widthMax: 16, widthCur: null } : l)),
  };
  expect(nodeLive(graph, null, null).get('pci:0000:01:00.0')!.lanes).toBe(8);
  expect(nodeLive(wide, null, null).get('pci:0000:01:00.0')!.lanes).toBe(16);
  expect(nodeLive(wide, snapshot, null).get('pci:0000:01:00.0')!.lanes).toBe(8);
});

test('nodeLive: a GPU inside the processor, and a block that is not a card, have no lanes', () => {
  const live = nodeLive(graph, snapshot, placement);
  expect(live.get('pci:0000:0d:00.0')!.lanes).toBeNull();
  expect(live.get('cpu')!.lanes).toBeNull();
  expect(live.get('pci:0000:02:00.0')!.lanes).toBeNull();
});

test('nodeLive: a hidden card keeps the lanes of its slot', () => {
  const s = {
    ...snapshot,
    allGpus: snapshot.allGpus.map((g) => (g.busId === '0000:08:00.0' ? { ...g, hidden: true } : g)),
  } as Snapshot;
  expect(nodeLive(graph, s, placement).get('pci:0000:08:00.0')).toMatchObject({ dim: true, lanes: 4 });
});

test('linkSpecs: the current state of each PCIe link, a GPU sample winning over the graph', () => {
  // Link `a` is Gen1 x8 in the graph (read at rest), Gen5 x8 in the sample
  expect(linkSpecs(graph, null)).toEqual(
    new Map([
      ['a', 'Gen1 x8'],
      ['b', 'Gen4 x4'],
      ['c', 'Gen4 x4'],
      ['d', 'Gen1 x4'],
    ]),
  );
  const specs = linkSpecs(graph, snapshot);
  expect(specs.get('a')).toBe('Gen5 x8');
  expect(specs.get('d')).toBe('Gen4 x4');
  expect(specs.has('cpu-ram')).toBe(false);
  expect(specs.has('e')).toBe(false);
});

test('detailOf: the selected block with its figures, nothing once it is not in the graph', () => {
  const live = nodeLive(graph, snapshot, placement);
  const detail = detailOf(graph, live, 'pci:0000:01:00.0');
  expect(detail?.node.label).toBe('RTX 5070 Ti');
  expect(detail?.live).toBe(live.get('pci:0000:01:00.0'));
  expect(detailOf(graph, live, 'pci:0000:99:00.0')).toBeNull();
  expect(detailOf(graph, live, null)).toBeNull();
  expect(detailOf(graph, new Map(), 'cpu')).toBeNull();
});

test('layerSlice: returns label, bytes and VRAM share for each filled GPU layer and its free remainder', () => {
  const total = 16 * GIB;
  const rtx = nodeLive(graph, snapshot, placement).get('pci:0000:01:00.0')!;
  expect(layerSlice(rtx, 'model')).toEqual({ kind: 'model', label: 'Model', bytes: 12e9, pct: (100 * 12e9) / total });
  expect(layerSlice(rtx, 'kv')).toEqual({ kind: 'kv', label: 'KV cache', bytes: 80e6, pct: (100 * 80e6) / total });
  expect(layerSlice(rtx, 'compute')).toEqual({
    kind: 'compute',
    label: 'Compute buffers',
    bytes: 285e6,
    pct: (100 * 285e6) / total,
  });
  const otherBytes = 12 * GIB - 12.365e9;
  expect(layerSlice(rtx, 'other')).toEqual({
    kind: 'other',
    label: 'Other VRAM',
    bytes: otherBytes,
    pct: (100 * otherBytes) / total,
  });
  expect(layerSlice(rtx, 'free')).toEqual({ kind: 'free', label: 'Free VRAM', bytes: 4 * GIB, pct: 25 });
  expect(layerSlice(rtx, 'used')).toBeNull();
});

test('layerSlice: handles unsplit VRAM, empty, full, scaled loading and missing samples', () => {
  const unsplit = nodeLive(graph, snapshot, null).get('pci:0000:01:00.0')!;
  expect(layerSlice(unsplit, 'used')).toEqual({ kind: 'used', label: 'Used VRAM', bytes: 12 * GIB, pct: 75 });
  expect(layerSlice(unsplit, 'free')).toEqual({ kind: 'free', label: 'Free VRAM', bytes: 4 * GIB, pct: 25 });

  const empty = nodeLive(graph, withGpu({ vramUsedBytes: 0 }), null).get('pci:0000:01:00.0')!;
  expect(layerSlice(empty, 'used')).toBeNull();
  expect(layerSlice(empty, 'free')).toEqual({ kind: 'free', label: 'Free VRAM', bytes: 16 * GIB, pct: 100 });

  const full = nodeLive(graph, withGpu({ vramUsedBytes: 16 * GIB }), null).get('pci:0000:01:00.0')!;
  expect(layerSlice(full, 'used')).toEqual({ kind: 'used', label: 'Used VRAM', bytes: 16 * GIB, pct: 100 });
  expect(layerSlice(full, 'free')).toBeNull();

  // Loading: scaled layers still leave the measured free VRAM, and say the size the logs announce (the details' one)
  const loading = nodeLive(graph, withGpu({ vramUsedBytes: 4 * GIB }), placement).get('pci:0000:01:00.0')!;
  const shrunk = layerSlice(loading, 'model')!;
  expect(shrunk.announcedBytes).toBe(12e9);
  expect(shrunk.bytes).toBeCloseTo((12e9 * 4 * GIB) / 12.365e9, 0);
  expect(shrunk.pct).toBeCloseTo((100 * shrunk.bytes) / (16 * GIB), 6);
  expect(loading.facts).toContainEqual({ label: 'Model', value: '11.2 GiB' });
  expect(layerSlice(loading, 'other')).toBeNull();
  expect(layerSlice(loading, 'free')!.bytes).toBeCloseTo(12 * GIB, 0);
  expect(layerSlice(loading, 'free')!.pct).toBeCloseTo(75, 6);

  // Hidden GPU and missing sample have no capacity
  expect(layerSlice(nodeLive(graph, snapshot, placement).get('pci:0000:0d:00.0'), 'free')).toBeNull();
  expect(layerSlice(nodeLive(graph, null, placement).get('pci:0000:01:00.0'), 'free')).toBeNull();
  expect(layerSlice(undefined, 'model')).toBeNull();
});

test('layerTooltip target encoding round-trips node ids containing colons', () => {
  const encoded = encodeLayerTarget('pci:0000:01:00.0', 'kv');
  expect(decodeLayerTarget(encoded)).toEqual({ nodeId: 'pci:0000:01:00.0', kind: 'kv' });
  expect(decodeLayerTarget('invalid')).toBeNull();
  expect(decodeLayerTarget('pci:0000:01:00.0\0bogus')).toBeNull();
});
