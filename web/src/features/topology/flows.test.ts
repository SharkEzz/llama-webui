import type { GpuSample, ModelPlacement, Snapshot, TopologyGraph } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { levelOf, linkBadge, linkFlows, linkShown, nodeLive, peerLinks, placementSeries } from './flows';

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
  const sampled = { ...snapshot, system: { ...snapshot.system, corePct: Array(16).fill(0) } } as Snapshot;
  expect(linkFlows(graph, sampled).get('cpu-ram')!.activity).toBeCloseTo(140 / 16, 5);
  // Every thread busy: 100, not 1200.
  const full = { ...snapshot, proc: { cpuPct: 1200, rssBytes: 0 } } as Snapshot;
  expect(linkFlows(graph, full).get('cpu-ram')!.activity).toBe(100);
  // No managed server: the machine's own load.
  expect(linkFlows(graph, { ...snapshot, proc: null } as Snapshot).get('cpu-ram')!.activity).toBe(18);
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
const withGpu = (o: Partial<GpuSample>): Snapshot =>
  ({ ...snapshot, allGpus: [{ ...snapshot.allGpus[0]!, ...o }, ...snapshot.allGpus.slice(1)] }) as Snapshot;
const withDisk = (readBps: number, writeBps: number): Snapshot =>
  ({ ...snapshot, disk: { ...snapshot.disk!, perDisk: { nvme0n1: { readBps, writeBps } } } }) as Snapshot;

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
    return linkBadge(link, g.nodes.find((n) => n.id === link.to)!, linkFlows(g, s).get(id)!, busy);
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
  expect(linkBadge(link, g.nodes.find((n) => n.id === link.to)!, linkFlows(g, s).get('c')!, false)!.lines).toEqual([
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
  expect(loading.layers[3]).toEqual({ kind: 'other', pct: 0 });
  expect(loading.facts.some((f) => f.label === 'Other VRAM')).toBe(false);
});

test('nodeLive: without a known split a GPU tank has one layer; a hidden GPU has none', () => {
  const live = nodeLive(graph, snapshot, null);
  expect(live.get('pci:0000:01:00.0')!.layers).toEqual([{ kind: 'used', pct: 75 }]);
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
    layers: [{ kind: 'used', pct: 37.5 }],
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

test('peerLinks: three cards of one backend are joined as a chain, in the order of the scene', () => {
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

test('linkShown: at rest only from 8 MiB/s in the busier direction, from 100 kB/s while llama-server works', () => {
  const mib = 1024 ** 2;
  expect(linkShown({ fwdBps: 4 * mib, backBps: 1 * mib }, false)).toBe(false);
  expect(linkShown({ fwdBps: 0, backBps: 8 * mib }, false)).toBe(true);
  expect(linkShown({ fwdBps: 4 * mib, backBps: null }, true)).toBe(true);
  expect(linkShown({ fwdBps: 50e3, backBps: 50e3 }, true)).toBe(false);
  expect(linkShown({ fwdBps: null, backBps: null }, true)).toBe(false);
});
