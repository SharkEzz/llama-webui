import { assert, describe, it } from '@effect/vitest';
import type { GpuReading } from '@llama-webui/shared';
import { Array as Arr, Record } from 'effect';
import { identityReading } from '../gpu.ts';
import { nvmlReader } from './read.ts';
import type { NvmlSymbols } from './symbols.ts';

const GiB = 1024 ** 3;
const SUCCESS = 0;
const NOT_SUPPORTED = 3;
const INSUFFICIENT_SIZE = 7;
const UNKNOWN = 999;

/** What a fake card answers. */
interface FakeCard {
  readonly handle: bigint;
  readonly uuid: string;
  readonly busId: string;
  /** pids on the card, 1 GiB each */
  readonly pids?: ReadonlyArray<number>;
}

const CARD_A: FakeCard = { handle: 0x10n, uuid: 'GPU-a', busId: '00000000:01:00.0', pids: [4242] };
const CARD_B: FakeCard = { handle: 0x20n, uuid: 'GPU-b', busId: '00000000:0D:00.0' };

/** The reading of a fake card in full, as `fakeNvml` answers it. */
const fullReading = (key: string, busId: string): GpuReading => ({
  key,
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 5070 Ti',
  busId,
  utilPct: 30,
  memUtilPct: 40,
  vramUsedBytes: 6 * GiB,
  vramTotalBytes: 16 * GiB,
  tempC: 45,
  powerW: 120,
  powerLimitW: 300,
  powerDefaultLimitW: 285,
  persistence: true,
  clockGrMhz: 2800,
  clockGrMaxMhz: 3100,
  clockMemMhz: 14001,
  fanPct: 30,
  pcieGen: 4,
  pcieWidth: 16,
  pcieGenMax: 5,
  pcieWidthMax: 16,
  pcieRxBps: 100 * 1024,
  pcieTxBps: 50 * 1024,
});

/**
 * A fake libnvidia-ml over `cards`. Every call is counted by name and card (`<symbol>@<handle>`, the system's calls
 * by name alone); `rcs` scripts the return codes of a call, one per call in order, then success.
 */
const fakeNvml = (cards: ReadonlyArray<FakeCard>, rcs: Record<string, Array<number>> = {}) => {
  const calls = new Map<string, number>();
  const byHandle = new Map(Arr.map(cards, (c) => [c.handle, c] as const));
  const count = (key: string): number => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const scripted = rcs[key];
    return scripted !== undefined && scripted.length > 0 ? (scripted.shift() ?? SUCCESS) : SUCCESS;
  };
  /** A call on a card: its code, then `fill` on success. */
  const on =
    <Args extends Array<unknown>>(name: string, fill: (card: FakeCard, ...args: Args) => void) =>
    (h: bigint, ...args: Args): number => {
      const card = byHandle.get(h);
      if (card === undefined) return 2; // NVML_ERROR_INVALID_ARGUMENT
      const rc = count(`${name}@${card.uuid}`);
      if (rc === SUCCESS) fill(card, ...args);
      return rc;
    };
  const u32 =
    (value: number) =>
    (_: FakeCard, out: Buffer): void => {
      out.writeUInt32LE(value, 0);
    };
  const typed =
    (values: Record<number, number>) =>
    (_: FakeCard, type: number, out: Buffer): void => {
      out.writeUInt32LE(values[type] ?? 0, 0);
    };
  const str = (buf: Buffer, len: number, s: string): void => {
    buf.fill(0, 0, len);
    buf.write(s, 0, 'utf8');
  };
  const lib: NvmlSymbols = {
    nvmlInit_v2: () => SUCCESS,
    nvmlShutdown: () => SUCCESS,
    nvmlDeviceGetCount_v2: (out) => {
      out.writeUInt32LE(cards.length, 0);
      return SUCCESS;
    },
    nvmlDeviceGetHandleByIndex_v2: (i, out) => {
      const card = cards[i];
      if (card === undefined) return 2;
      out.writeBigUInt64LE(card.handle, 0);
      return SUCCESS;
    },
    nvmlDeviceGetUUID: on('UUID', (card, buf: Buffer, len: number) => str(buf, len, card.uuid)),
    nvmlDeviceGetName: on('Name', (_, buf: Buffer, len: number) => str(buf, len, 'NVIDIA GeForce RTX 5070 Ti')),
    nvmlDeviceGetPciInfo_v3: on('PciInfo', (card, out: Buffer) => {
      out.fill(0);
      out.write(card.busId, 36, 'utf8');
    }),
    nvmlDeviceGetMemoryInfo_v2: on('MemoryInfo', (_, out: Buffer) => {
      out.writeBigUInt64LE(BigInt(16 * GiB), 8);
      out.writeBigUInt64LE(BigInt(6 * GiB), 32);
    }),
    nvmlDeviceGetUtilizationRates: on('UtilizationRates', (_, out: Buffer) => {
      out.writeUInt32LE(30, 0);
      out.writeUInt32LE(40, 4);
    }),
    nvmlDeviceGetTemperature: on('Temperature', typed({ 0: 45 })),
    nvmlDeviceGetPowerUsage: on('PowerUsage', u32(120_000)),
    nvmlDeviceGetPowerManagementLimit: on('PowerManagementLimit', u32(300_000)),
    nvmlDeviceGetPowerManagementDefaultLimit: on('PowerManagementDefaultLimit', u32(285_000)),
    nvmlDeviceGetPersistenceMode: on('PersistenceMode', u32(1)),
    nvmlSystemGetDriverVersion: (buf, len) => {
      const rc = count('DriverVersion');
      if (rc === SUCCESS) str(buf, len, '580.95.05');
      return rc;
    },
    nvmlSystemGetCudaDriverVersion: (out) => {
      const rc = count('CudaDriverVersion');
      if (rc === SUCCESS) out.writeInt32LE(13000, 0);
      return rc;
    },
    nvmlDeviceGetClockInfo: on('ClockInfo', typed({ 0: 2800, 2: 14001 })),
    nvmlDeviceGetMaxClockInfo: on('MaxClockInfo', typed({ 0: 3100 })),
    nvmlDeviceGetFanSpeed: on('FanSpeed', u32(30)),
    nvmlDeviceGetPcieThroughput: on('PcieThroughput', typed({ 0: 50, 1: 100 })),
    nvmlDeviceGetCurrPcieLinkGeneration: on('CurrPcieLinkGeneration', u32(4)),
    nvmlDeviceGetCurrPcieLinkWidth: on('CurrPcieLinkWidth', u32(16)),
    nvmlDeviceGetMaxPcieLinkGeneration: on('MaxPcieLinkGeneration', u32(5)),
    nvmlDeviceGetMaxPcieLinkWidth: on('MaxPcieLinkWidth', u32(16)),
    nvmlDeviceGetComputeRunningProcesses_v3: (h, count_, infos) => {
      const card = byHandle.get(h);
      if (card === undefined) return 2;
      const rc = count(`ComputeRunningProcesses@${card.uuid}`);
      if (rc !== SUCCESS) return rc;
      const pids = card.pids ?? [];
      if (count_.readUInt32LE(0) < pids.length) {
        count_.writeUInt32LE(pids.length, 0);
        return INSUFFICIENT_SIZE;
      }
      count_.writeUInt32LE(pids.length, 0);
      Arr.forEach(pids, (pid, i) => {
        infos.writeUInt32LE(pid, i * 24);
        infos.writeBigUInt64LE(BigInt(GiB), i * 24 + 8);
      });
      return SUCCESS;
    },
  };
  const of = (call: string, card?: FakeCard): number =>
    calls.get(card === undefined ? call : `${call}@${card.uuid}`) ?? 0;
  return { lib, of };
};

const handlesOf = (cards: ReadonlyArray<FakeCard>) => Arr.map(cards, (c) => c.handle);

/** The calls of a card made at most once, whatever the number of samples. */
const STATIC_CALLS = [
  'UUID',
  'Name',
  'PciInfo',
  'MaxClockInfo',
  'MaxPcieLinkGeneration',
  'MaxPcieLinkWidth',
  'PowerManagementDefaultLimit',
];
/** The calls of a card made on every sample (the PCIe throughput twice: rx and tx; the clocks twice). */
const SAMPLE_CALLS: Record<string, number> = {
  MemoryInfo: 1,
  UtilizationRates: 1,
  PersistenceMode: 1,
  Temperature: 1,
  PowerUsage: 1,
  PowerManagementLimit: 1,
  ClockInfo: 2,
  FanSpeed: 1,
  CurrPcieLinkGeneration: 1,
  CurrPcieLinkWidth: 1,
  PcieThroughput: 2,
  ComputeRunningProcesses: 1,
};

describe('the NVML reader', () => {
  it('reads what does not change once, and the rest on every sample', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const samples = [read({ skipGpus: [] }), read({ skipGpus: [] }), read({ skipGpus: [] })];
    for (const card of [CARD_A, CARD_B]) {
      for (const call of STATIC_CALLS) assert.strictEqual(nvml.of(call, card), 1, `${call} of ${card.uuid}`);
      for (const [call, n] of Record.toEntries(SAMPLE_CALLS))
        assert.strictEqual(nvml.of(call, card), 3 * n, `${call} of ${card.uuid}`);
    }
    assert.strictEqual(nvml.of('DriverVersion'), 1);
    assert.strictEqual(nvml.of('CudaDriverVersion'), 1);
    for (const snapshot of samples)
      assert.deepStrictEqual(snapshot, {
        gpus: [fullReading('nvidia:GPU-a', '0000:01:00.0'), fullReading('nvidia:GPU-b', '0000:0d:00.0')],
        procs: [{ pid: 4242, key: 'nvidia:GPU-a', usedBytes: GiB }],
        system: { driver: '580.95.05', cudaDriver: 13000 },
      });
  });

  it('identifies a hidden card without reading it, and reads it in full once it is shown', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const hidden = { skipGpus: ['0000:0d:00.0'] };
    const first = read(hidden);
    read(hidden);
    assert.deepStrictEqual(
      first.gpus[1],
      identityReading(
        { key: 'nvidia:GPU-b', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070 Ti', busId: '0000:0d:00.0' },
        'hidden',
      ),
    );
    for (const call of ['UUID', 'Name', 'PciInfo']) assert.strictEqual(nvml.of(call, CARD_B), 1, call);
    for (const call of ['MaxClockInfo', 'PowerManagementDefaultLimit', ...Record.keys(SAMPLE_CALLS)])
      assert.strictEqual(nvml.of(call, CARD_B), 0, call);
    const shown = read({ skipGpus: [] });
    assert.deepStrictEqual(shown.gpus[1], fullReading('nvidia:GPU-b', '0000:0d:00.0'));
    assert.strictEqual(nvml.of('MaxClockInfo', CARD_B), 1);
  });

  it('asks a value that does not change again after a failure, and keeps it once read', () => {
    const nvml = fakeNvml([CARD_A], {
      'UUID@GPU-a': [UNKNOWN],
      'Name@GPU-a': [UNKNOWN],
      'MaxClockInfo@GPU-a': [UNKNOWN],
      DriverVersion: [UNKNOWN],
    });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    const first = read({ skipGpus: [] });
    assert.deepStrictEqual(first.gpus, [], 'a card without its UUID is left out of the sample');
    assert.strictEqual(first.system.driver, null);
    const second = read({ skipGpus: [] });
    assert.strictEqual(second.gpus[0]?.name, 'NVIDIA GPU', 'the name of a card that refuses it');
    assert.strictEqual(second.gpus[0]?.clockGrMaxMhz, null);
    assert.strictEqual(second.system.driver, '580.95.05');
    const third = read({ skipGpus: [] });
    assert.deepStrictEqual(third.gpus, [fullReading('nvidia:GPU-a', '0000:01:00.0')]);
    read({ skipGpus: [] });
    assert.deepStrictEqual(
      [nvml.of('UUID', CARD_A), nvml.of('Name', CARD_A), nvml.of('MaxClockInfo', CARD_A), nvml.of('DriverVersion')],
      [2, 2, 2, 2],
    );
  });

  it('does not ask again for a value the card does not support', () => {
    const nvml = fakeNvml([CARD_A], { 'PowerManagementDefaultLimit@GPU-a': [NOT_SUPPORTED] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    const samples = [read({ skipGpus: [] }), read({ skipGpus: [] }), read({ skipGpus: [] })];
    for (const s of samples) assert.strictEqual(s.gpus[0]?.powerDefaultLimitW, null);
    assert.strictEqual(nvml.of('PowerManagementDefaultLimit', CARD_A), 1);
  });

  it('lists every process of a card, beyond what the first buffer holds, on every sample', () => {
    const pids = Array.from({ length: 70 }, (_, i) => 1000 + i);
    const nvml = fakeNvml([{ ...CARD_A, pids }]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    for (let i = 0; i < 2; i++)
      assert.deepStrictEqual(
        Arr.map(read({ skipGpus: [] }).procs, (p) => p.pid),
        pids,
      );
  });

  it('leaves out the processes of a card that refuses them, and reads them at the next sample', () => {
    const nvml = fakeNvml([CARD_A], { 'ComputeRunningProcesses@GPU-a': [UNKNOWN] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    assert.deepStrictEqual(read({ skipGpus: [] }).procs, []);
    assert.deepStrictEqual(read({ skipGpus: [] }).procs, [{ pid: 4242, key: 'nvidia:GPU-a', usedBytes: GiB }]);
  });
});
