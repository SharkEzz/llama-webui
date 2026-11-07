import { expect, test } from 'bun:test';
import type { GpuSample, ModelPlacement, Snapshot, TopologyGraph } from '@llama-webui/shared';
import { linkFlows, nodeLive, placementSeries } from './flows';

const graph: TopologyGraph = {
  at: 0,
  nodes: [
    { id: 'cpu', kind: 'cpu', label: 'Ryzen', detail: { physicalCores: 6, logicalThreads: 12, numaNodes: 1 } },
    { id: 'ram', kind: 'ram', label: 'Mémoire', detail: { totalBytes: 32 * 1024 ** 3, dimms: 2, tempC: 29.5 } },
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
  disk: { readBps: 900e6, writeBps: 5e6, model: { disk: 'nvme0n1', readBps: 850e6 } },
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
  });
  // AMD: no rate in sysfs; the link is known, its traffic is not.
  expect(f.get('d')).toMatchObject({ fwdBps: null, backBps: null, capacityBps: 4 * 1.969e9 });
});

test('linkFlows: the model disk feeds its NVMe link; chipset sums what sits behind it; memory shows activity only', () => {
  const f = linkFlows(graph, snapshot);
  expect(f.get('b')).toMatchObject({ fwdBps: 850e6, backBps: 5e6, capacityBps: 4 * 1.969e9 });
  expect(f.get('c')).toMatchObject({ fwdBps: null, backBps: null }); // nothing measurable behind it
  expect(f.get('cpu-ram')).toMatchObject({ fwdBps: null, backBps: null, activity: 140, capacityBps: null });
  expect(f.get('e')).toMatchObject({ fwdBps: null, backBps: null, activity: null, capacityBps: null });
});

test('linkFlows / nodeLive: with perf, the memory link carries measured DRAM traffic (writes forward, reads back)', () => {
  const s = {
    ...snapshot,
    system: { ...snapshot.system, memBw: { readBps: 3e9, writeBps: 1e9 } },
    proc: { cpuPct: 140, rssBytes: 3 * 1024 ** 3, dramBps: 2.5e9 },
  } as Snapshot;
  expect(linkFlows(graph, s).get('cpu-ram')).toMatchObject({ fwdBps: 1e9, backBps: 3e9, activity: null });
  const ram = nodeLive(graph, s, placement).get('ram')!;
  expect(ram.headline).toBe('3,7 Go/s');
  expect(ram.facts.map((f) => f.label)).toEqual([
    'Utilisée',
    'Lecture',
    'Écriture',
    'llama-server (DRAM)',
    'llama-server (RSS)',
    'Modèle en RAM',
    'Barrettes',
  ]);
});

test('linkFlows: without a snapshot every flow is unknown, capacities still known', () => {
  const f = linkFlows(graph, null);
  expect(f.get('a')).toMatchObject({ fwdBps: null, backBps: null, capacityBps: 8 * 0.25e9, maxBps: 8 * 3.938e9 });
  // A disk not holding the model, alone on the machine: total disk rates.
  const alone = { ...graph, nodes: graph.nodes.filter((n) => n.kind !== 'gpu' || n.busId === '0000:01:00.0') };
  const s = { ...snapshot, disk: { readBps: 900e6, writeBps: 5e6, model: null } } as Snapshot;
  expect(linkFlows(alone, s).get('b')).toMatchObject({ fwdBps: 900e6, backBps: 5e6 });
});

test('nodeLive: GPU facts, load and dimming', () => {
  const live = nodeLive(graph, snapshot, placement);
  const rtx = live.get('pci:0000:01:00.0')!;
  expect(rtx.loadPct).toBe(80);
  expect(rtx.fillPct).toBe(75);
  expect(rtx.dim).toBe(false);
  expect(rtx.headline).toBe('80 %');
  expect(rtx.facts.map((f) => f.label)).toEqual([
    'Utilisation',
    'VRAM',
    'Modèle',
    'Cache KV',
    'Température',
    'Puissance',
    'Lien PCIe',
  ]);
  expect(rtx.facts.find((f) => f.label === 'Modèle')!.value).toBe('11,2 Go');
  expect(rtx.facts.find((f) => f.label === 'Lien PCIe')!.value).toBe('Gen5 x8');

  const igpu = live.get('pci:0000:0d:00.0')!;
  expect(igpu.dim).toBe(true);
  expect(igpu.headline).toBe('masquée');
  expect(igpu.loadPct).toBeNull();
});

test('nodeLive: CPU, RAM, NVMe and chipset', () => {
  const live = nodeLive(graph, snapshot, placement);
  expect(live.get('cpu')).toMatchObject({ loadPct: 18, headline: '18 %' });
  expect(live.get('cpu')!.facts.find((f) => f.label === 'llama-server')!.value).toBe('140 %');
  const ram = live.get('ram')!;
  expect(ram.fillPct).toBe(37.5);
  expect(ram.facts.find((f) => f.label === 'Modèle en RAM')!.value).toBe('25,1 Go');
  expect(ram.facts.find((f) => f.label === 'Barrettes')!.value).toBe('2 · 29,5 °C');
  expect(live.get('pci:0000:02:00.0')).toMatchObject({ headline: '810,6 Mo/s' });
  expect(live.get('chipset:0000:04:00.0')).toMatchObject({ loadPct: null, headline: 'Gen4 x4' });
});

test('placementSeries: GPUs in graph order with their tone, host last, none when unknown', () => {
  const s = placementSeries(graph, placement);
  expect(s.map((x) => [x.label, x.bytes, x.nodeId])).toEqual([
    ['CUDA0', 12e9, 'pci:0000:01:00.0'],
    ['ROCm0', 11e9, 'pci:0000:08:00.0'],
    ['Hôte (RAM)', 27e9, 'ram'],
  ]);
  expect(placementSeries(graph, null)).toEqual([]);
});
