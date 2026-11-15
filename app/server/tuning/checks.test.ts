import { assert, describe, it } from '@effect/vitest';
import type { Check, Estimate, GpuSample } from '@llama-webui/shared';
import { Array as Arr, Option, String as Str } from 'effect';
import { fakeModel, hw3 } from '../testing/tuning.ts';
import { type CheckContext, runChecks, type SysReadings, summarize } from './checks.ts';
import { estimate } from './estimate.ts';
import { retainedBusIds } from './match.ts';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const DAY = 86400_000;
const NOW = 1_800_000_000_000;

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
const ctx = (o: Partial<CheckContext> = {}, r: Partial<SysReadings> = {}): CheckContext => ({
  readings: { ...readings, ...r },
  gpus: [],
  retainedBusIds: [],
  devices: hw3().devices,
  cpu: hw3().cpu,
  model: null,
  estimate: null,
  mem: null,
  diskSpeed: null,
  now: NOW,
  ...o,
});
const byId = (c: CheckContext, id: string): Check =>
  Option.getOrThrowWith(
    Arr.findFirst(runChecks(c), (x) => x.id === id),
    () => new Error(`no check ${id}`),
  );
const stateOf = (c: CheckContext, id: string) => byId(c, id).state;

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
const rx = gpu({
  key: 'amd:0000:08:00.0',
  vendor: 'amd',
  name: 'Navi 48',
  busId: '0000:08:00.0',
  vramTotalBytes: 16304 * MiB,
});
const on = (g: GpuSample, o: Partial<CheckContext> = {}, r: Partial<SysReadings> = {}) =>
  ctx({ gpus: [g], retainedBusIds: [g.busId], ...o }, r);

/** An estimate that spills into RAM (a partial offload, --mlock recommended). */
const spilling = (): Estimate =>
  estimate({
    model: fakeModel({ layers: 60, otherBytesPerLayer: 500 * MiB }),
    hw: hw3(),
    preset: 'chat',
    mmprojBytes: 0,
    pinned: { dev: ['CUDA0'] },
  });

describe('runChecks', () => {
  it('a governor other than performance is a warning with the exact command', () => {
    const g = byId(ctx(), 'cpu.governor');
    assert.strictEqual(g.state, 'warn');
    assert.strictEqual(g.command, 'echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor');
    assert.strictEqual(stateOf(ctx({}, { governors: ['performance'] }), 'cpu.governor'), 'ok');
    assert.strictEqual(stateOf(ctx({}, { governors: [] }), 'cpu.governor'), 'unknown');
  });

  it('disk speed: unknown until measured, warning under 2 GiB/s', () => {
    assert.strictEqual(stateOf(ctx(), 'kernel.disk-speed'), 'unknown');
    const slow = { bytesPerSec: 1.2 * GiB, sampledBytes: GiB, path: '/m', at: 0 };
    assert.strictEqual(stateOf(ctx({ diskSpeed: slow }), 'kernel.disk-speed'), 'warn');
    assert.strictEqual(stateOf(ctx({ diskSpeed: { ...slow, bytesPerSec: 5 * GiB } }), 'kernel.disk-speed'), 'ok');
  });

  it('only the cards of the estimate are retained: the others are not applicable (#36)', () => {
    const retained = retainedBusIds({ devices: hw3().devices, gpus: [cuda0, cuda1], dev: ['CUDA1'] });
    assert.deepStrictEqual(retained, ['0000:02:00.0']);
    const c = ctx({ gpus: [cuda0, cuda1], retainedBusIds: retained });
    assert.strictEqual(stateOf(c, 'nvidia.persistence.0000:01:00.0'), 'na');
    assert.strictEqual(stateOf(c, 'nvidia.persistence.0000:02:00.0'), 'ok');
    // No -dev: every dedicated card.
    assert.deepStrictEqual(retainedBusIds({ devices: hw3().devices, gpus: [cuda0, cuda1], dev: undefined }), [
      '0000:01:00.0',
      '0000:02:00.0',
    ]);
  });

  it('a PCIe link trained down while the card is idle is unknown, not a warning (#36)', () => {
    const idle = { ...cuda0, pcieGen: 1, utilPct: 0 };
    assert.strictEqual(stateOf(on(idle), 'nvidia.pcie.0000:01:00.0'), 'unknown');
    const busy = { ...cuda0, pcieGen: 3, utilPct: 90 };
    const warn = byId(on(busy), 'nvidia.pcie.0000:01:00.0');
    assert.strictEqual(warn.state, 'warn');
    assert.strictEqual(warn.persistence, 'permanent');
    const full = byId(on(cuda0), 'nvidia.pcie.0000:01:00.0');
    assert.deepStrictEqual([full.state, full.detail], ['ok', 'x16 Gen5 (max x16 Gen5)']);
    assert.isFalse('persistence' in full);
    assert.strictEqual(stateOf(on({ ...cuda0, pcieGenMax: null }), 'nvidia.pcie.0000:01:00.0'), 'unknown');
    assert.strictEqual(
      byId(on({ ...cuda0, pcieGen: null }), 'nvidia.pcie.0000:01:00.0').detail,
      'measured under load: start the server first',
    );
  });

  it('NVIDIA persistence and power limit name the card by its UUID', () => {
    const off = byId(on({ ...cuda0, persistence: false }), 'nvidia.persistence.0000:01:00.0');
    assert.deepStrictEqual(
      [off.state, off.command, off.persistence],
      ['warn', 'sudo nvidia-smi -i a -pm 1', 'session'],
    );
    assert.strictEqual(stateOf(on({ ...cuda0, persistence: null }), 'nvidia.persistence.0000:01:00.0'), 'unknown');
    const capped = byId(on({ ...cuda0, powerLimitW: 200, powerDefaultLimitW: 300 }), 'nvidia.powerlimit.0000:01:00.0');
    assert.deepStrictEqual([capped.state, capped.command], ['warn', 'sudo nvidia-smi -i a -pl 300']);
    assert.strictEqual(
      stateOf(on({ ...cuda0, powerLimitW: 300, powerDefaultLimitW: 300 }), 'nvidia.powerlimit.0000:01:00.0'),
      'ok',
    );
    assert.strictEqual(stateOf(on(cuda0), 'nvidia.powerlimit.0000:01:00.0'), 'unknown');
    assert.strictEqual(stateOf(ctx({ gpus: [cuda0] }), 'nvidia.powerlimit.0000:01:00.0'), 'na');
  });

  it('a BAR1 smaller than the VRAM is a warning (Resizable BAR off)', () => {
    const id = 'nvidia.rebar.0000:01:00.0';
    assert.strictEqual(stateOf(on(cuda0), id), 'unknown');
    assert.strictEqual(stateOf(on(cuda0, {}, { bar1Bytes: { '0000:01:00.0': 256 * MiB } }), id), 'warn');
    assert.strictEqual(stateOf(on(cuda0, {}, { bar1Bytes: { '0000:01:00.0': 32 * GiB } }), id), 'ok');
  });

  it('the NVIDIA driver and nvidia_uvm', () => {
    assert.strictEqual(byId(on(cuda0), 'nvidia.driver').detail, 'driver 580.1, CUDA 13.0');
    assert.strictEqual(stateOf(on(cuda0, {}, { cudaDriverError: true }), 'nvidia.driver'), 'warn');
    assert.strictEqual(stateOf(on(cuda0, {}, { driver: null }), 'nvidia.driver'), 'unknown');
    assert.strictEqual(stateOf(on(cuda0), 'nvidia.uvm'), 'ok');
    const missing = byId(on(cuda0, {}, { modules: ['amdgpu'] }), 'nvidia.uvm');
    assert.deepStrictEqual([missing.state, missing.command], ['warn', 'sudo modprobe nvidia_uvm']);
    assert.strictEqual(stateOf(on(cuda0, {}, { modules: [] }), 'nvidia.uvm'), 'unknown');
  });

  it('no NVIDIA card, no NVIDIA check; no AMD card, no AMD check', () => {
    const ids = Arr.map(runChecks(ctx()), (c) => c.id);
    assert.isFalse(Arr.some(ids, (id) => Str.startsWith('nvidia.')(id) || Str.startsWith('amd.')(id)));
  });

  it('AMD: the DPM level, the HIP backend and the ROCm notice', () => {
    const dpm = { '0000:08:00.0': { level: 'auto', path: '/sys/x/power_dpm_force_performance_level' } };
    const auto = byId(on(rx, {}, { amdDpm: dpm }), 'amd.dpm.0000:08:00.0');
    assert.deepStrictEqual(
      [auto.state, auto.command],
      ['warn', 'echo high | sudo tee /sys/x/power_dpm_force_performance_level'],
    );
    const high = { '0000:08:00.0': { level: 'high', path: '/sys/x' } };
    assert.strictEqual(stateOf(on(rx, {}, { amdDpm: high }), 'amd.dpm.0000:08:00.0'), 'ok');
    assert.strictEqual(stateOf(on(rx), 'amd.dpm.0000:08:00.0'), 'unknown');
    assert.strictEqual(stateOf(on(rx), 'amd.hip'), 'warn');
    assert.strictEqual(stateOf(on(rx, {}, { backendLibs: ['libggml-hip.so'] }), 'amd.hip'), 'ok');
    assert.strictEqual(stateOf(on(rx, {}, { backendLibs: [] }), 'amd.hip'), 'unknown');
    assert.strictEqual(stateOf(on(rx), 'amd.rocm-gfx'), 'unknown');
    const idle = ctx({ gpus: [rx] });
    assert.deepStrictEqual(
      [stateOf(idle, 'amd.dpm.0000:08:00.0'), stateOf(idle, 'amd.hip'), stateOf(idle, 'amd.rocm-gfx')],
      ['na', 'na', 'na'],
    );
  });

  it('transparent hugepages: never is a warning', () => {
    assert.strictEqual(stateOf(ctx(), 'cpu.thp'), 'ok');
    assert.strictEqual(stateOf(ctx({}, { thp: 'never' }), 'cpu.thp'), 'warn');
    assert.strictEqual(stateOf(ctx({}, { thp: null }), 'cpu.thp'), 'unknown');
  });

  it('the memlock limit matters only when the estimate recommends --mlock', () => {
    assert.strictEqual(byId(ctx(), 'cpu.memlock').detail, '--mlock not recommended here');
    const e = spilling();
    assert.include(e.serverArgs, '--mlock');
    const model = fakeModel({ layers: 60, otherBytesPerLayer: 500 * MiB });
    assert.strictEqual(byId(ctx({ estimate: e, model }), 'cpu.memlock').detail, 'unlimited');
    assert.strictEqual(stateOf(ctx({ estimate: e, model }, { memlockLimitBytes: 8 * MiB }), 'cpu.memlock'), 'warn');
    assert.strictEqual(stateOf(ctx({ estimate: e, model }, { memlockLimitBytes: null }), 'cpu.memlock'), 'unknown');
  });

  it('swappiness and swap only warn when the model spills into RAM', () => {
    const e = spilling();
    const mem = {
      totalBytes: 64 * GiB,
      availableBytes: 50 * GiB,
      cachedBytes: 0,
      swapTotalBytes: 8 * GiB,
      swapUsedBytes: GiB,
    };
    assert.strictEqual(stateOf(ctx(), 'cpu.swappiness'), 'ok');
    assert.strictEqual(stateOf(ctx({ estimate: e }), 'cpu.swappiness'), 'warn');
    assert.strictEqual(stateOf(ctx({ estimate: e }, { swappiness: 10 }), 'cpu.swappiness'), 'ok');
    assert.strictEqual(stateOf(ctx({}, { swappiness: null }), 'cpu.swappiness'), 'unknown');
    assert.strictEqual(stateOf(ctx(), 'kernel.swap'), 'unknown');
    assert.strictEqual(byId(ctx({ mem }), 'kernel.swap').detail, '1.0 GiB used');
    assert.strictEqual(stateOf(ctx({ mem, estimate: e }), 'kernel.swap'), 'warn');
  });

  it('several NUMA nodes warn unless the estimate says --numa', () => {
    const cpu = { ...hw3().cpu, numaNodes: 2 };
    assert.strictEqual(stateOf(ctx(), 'cpu.numa'), 'ok');
    assert.strictEqual(stateOf(ctx({ cpu }), 'cpu.numa'), 'warn');
    const e = estimate({
      model: fakeModel({ layers: 36, otherBytesPerLayer: 120 * MiB }),
      hw: { ...hw3(), cpu },
      preset: 'chat',
      mmprojBytes: 0,
    });
    assert.strictEqual(stateOf(ctx({ cpu, estimate: e }), 'cpu.numa'), 'ok');
  });

  it('the build: CUDA backend, SIMD instructions and age', () => {
    assert.strictEqual(stateOf(ctx(), 'build.cuda'), 'ok');
    const noCudaList = Arr.filter(hw3().devices, (d) => d.backend !== 'CUDA');
    assert.strictEqual(
      stateOf(on(cuda0, { devices: noCudaList }, { backendLibs: ['libggml-vulkan.so'] }), 'build.cuda'),
      'warn',
    );
    assert.strictEqual(stateOf(on(cuda0, { devices: noCudaList }, { backendLibs: [] }), 'build.cuda'), 'unknown');
    assert.strictEqual(stateOf(on(cuda0, { devices: noCudaList }), 'build.cuda'), 'ok');

    assert.strictEqual(stateOf(ctx(), 'build.simd'), 'unknown');
    assert.strictEqual(
      byId(ctx({}, { systemInfo: 'CPU : AVX2 = 1 | AVX512 = 1 |' }), 'build.simd').detail,
      'AVX2, AVX512',
    );
    const missing = byId(ctx({}, { systemInfo: 'CPU : AVX2 = 1 | AVX512 = 0 |' }), 'build.simd');
    assert.deepStrictEqual(
      [missing.state, missing.detail],
      ['warn', 'AVX512 available but unused: rebuild with -DGGML_NATIVE=ON'],
    );

    assert.strictEqual(stateOf(ctx(), 'build.age'), 'unknown');
    assert.strictEqual(byId(ctx({}, { buildDate: NOW - DAY }), 'build.age').detail, '1 day');
    assert.deepStrictEqual(
      [
        stateOf(ctx({}, { buildDate: NOW - 90 * DAY }), 'build.age'),
        byId(ctx({}, { buildDate: NOW - 90 * DAY }), 'build.age').detail,
      ],
      ['warn', '90 days'],
    );
  });

  it('the IOMMU warns only with two cards and no passthrough', () => {
    const two = { retainedBusIds: ['0000:01:00.0', '0000:02:00.0'] };
    assert.strictEqual(byId(ctx(two), 'kernel.iommu').detail, 'inactive');
    assert.strictEqual(
      byId(ctx(two, { iommuActive: true, cmdline: 'quiet iommu=pt' }), 'kernel.iommu').detail,
      'passthrough',
    );
    assert.strictEqual(byId(ctx({}, { iommuActive: true }), 'kernel.iommu').detail, 'active, single card');
    assert.strictEqual(stateOf(ctx(two, { iommuActive: true }), 'kernel.iommu'), 'warn');
    assert.strictEqual(stateOf(ctx({}, { iommuActive: null }), 'kernel.iommu'), 'unknown');
  });

  it('a spinning or network model disk is a warning', () => {
    assert.strictEqual(byId(ctx(), 'kernel.disk').detail, 'ext4, SSD');
    assert.strictEqual(stateOf(ctx({}, { modelDisk: { rotational: true, fsType: 'ext4' } }), 'kernel.disk'), 'warn');
    assert.strictEqual(
      byId(ctx({}, { modelDisk: { rotational: null, fsType: 'nfs4' } }), 'kernel.disk').detail,
      'nfs4: move the model to a local SSD',
    );
    assert.strictEqual(stateOf(ctx({}, { modelDisk: null }), 'kernel.disk'), 'unknown');
  });
});

describe('summarize', () => {
  it('counts the checks of each state', () => {
    const checks = runChecks(ctx({ gpus: [cuda0, rx], retainedBusIds: ['0000:01:00.0'] }));
    const summary = summarize(checks);
    assert.strictEqual(summary.warn + summary.ok + summary.unknown + summary.na, checks.length);
    assert.strictEqual(
      summary.na,
      Arr.countBy(checks, (c) => c.state === 'na'),
    );
    assert.isAbove(summary.na, 0);
    assert.deepStrictEqual(summarize([]), { warn: 0, ok: 0, unknown: 0, na: 0 });
  });
});
