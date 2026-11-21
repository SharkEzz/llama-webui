import type { GpuSample } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { type CheckContext, runChecks } from './checks';
import { hw3 } from './fixtures';
import { retainedBusIds } from './match';
import type { SysReadings } from './sysinfo';

const GiB = 1024 ** 3;
const readings: SysReadings = {
  governors: ['schedutil', 'schedutil'],
  thp: 'madvise',
  memlockLimitBytes: Number.POSITIVE_INFINITY,
  swappiness: 60,
  cmdline: '',
  iommuActive: false,
  modules: ['nvidia_uvm'],
  backendLibs: ['libggml-cuda.so', 'libggml-vulkan.so'],
  driver: '580.1',
  cudaDriver: 13000,
  bar1Bytes: {},
  amdDpm: {},
  buildDate: null,
  systemInfo: null,
  cudaDriverError: false,
  modelDisk: { rotational: false, fsType: 'ext4' },
};
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({
  readings,
  gpus: [],
  retainedBusIds: [],
  devices: hw3().devices,
  cpu: hw3().cpu,
  model: null,
  estimate: null,
  mem: null,
  diskSpeed: null,
  now: Date.now(),
  ...o,
});
const byId = (c: CheckContext, id: string) => runChecks(c).find((x) => x.id === id)!;

test('a governor other than performance is a warning with the exact command', () => {
  const g = byId(ctx(), 'cpu.governor');
  expect(g.state).toBe('warn');
  expect(g.command).toBe('echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor');
});

test('disk speed: unknown until measured, warning under 2 GiB/s', () => {
  expect(byId(ctx(), 'kernel.disk-speed').state).toBe('unknown');
  const slow = { bytesPerSec: 1.2 * GiB, sampledBytes: GiB, path: '/m', at: 0 };
  expect(byId(ctx({ diskSpeed: slow }), 'kernel.disk-speed').state).toBe('warn');
  expect(byId(ctx({ diskSpeed: { ...slow, bytesPerSec: 5 * GiB } }), 'kernel.disk-speed').state).toBe('ok');
});

const MiB = 1024 ** 2;
const gpu = (o: Partial<GpuSample> & Pick<GpuSample, 'key' | 'name' | 'busId'>): GpuSample => ({
  vendor: 'nvidia',
  utilPct: 0,
  vramUsedBytes: 300 * MiB,
  vramTotalBytes: 16303 * MiB,
  tempC: null,
  powerW: null,
  procVramBytes: 0,
  persistence: true,
  pcieGen: 5,
  pcieWidth: 16,
  pcieGenMax: 5,
  pcieWidthMax: 16,
  ...o,
});
const cuda0 = gpu({ key: 'nvidia:a', name: 'NVIDIA GeForce RTX 5070 Ti', busId: '0000:01:00.0' });
const cuda1 = gpu({ key: 'nvidia:b', name: 'NVIDIA GeForce RTX 5060 Ti', busId: '0000:02:00.0' });

test('only the cards of the estimate are retained: the others are not applicable (#36)', () => {
  const retained = retainedBusIds(hw3().devices, [cuda0, cuda1], ['CUDA1']);
  expect(retained).toEqual(['0000:02:00.0']);
  const c = ctx({ gpus: [cuda0, cuda1], retainedBusIds: retained });
  expect(byId(c, 'nvidia.persistence.0000:01:00.0').state).toBe('na');
  expect(byId(c, 'nvidia.persistence.0000:02:00.0').state).toBe('ok');
  // No -dev: every dedicated card.
  expect(retainedBusIds(hw3().devices, [cuda0, cuda1], undefined)).toEqual(['0000:01:00.0', '0000:02:00.0']);
});

test('a PCIe link trained down while the card is idle is unknown, not a warning (#36)', () => {
  const idle = { ...cuda0, pcieGen: 1, utilPct: 0 };
  expect(byId(ctx({ gpus: [idle], retainedBusIds: [idle.busId] }), 'nvidia.pcie.0000:01:00.0').state).toBe('unknown');
  const busy = { ...cuda0, pcieGen: 3, utilPct: 90 };
  expect(byId(ctx({ gpus: [busy], retainedBusIds: [busy.busId] }), 'nvidia.pcie.0000:01:00.0').state).toBe('warn');
});
