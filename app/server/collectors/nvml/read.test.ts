import { assert, describe, it } from '@effect/vitest';
import type { GpuPeer, GpuReading } from '@llama-webui/shared';
import { Array as Arr, Record } from 'effect';
import { type GpuNeeds, identityReading } from '../gpu.ts';
import type { NvmlSnapshot } from './protocol.ts';
import { type NvmlSample, nvmlReader } from './read.ts';
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

/** The reading of a fake card in full, as `fakeNvml` answers it; `peers`: peer-to-peer to the other cards read. */
const fullReading = (key: string, busId: string, peers?: ReadonlyArray<GpuPeer>): GpuReading => ({
  ...(peers === undefined ? {} : { p2p: peers }),
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

/** What the cards answer to the calls that are not read on every sample, and to the fan; a test changes them. */
interface LiveValues {
  /** KiB/s */
  pcieRx: number;
  /** KiB/s */
  pcieTx: number;
  /** mW */
  powerLimit: number;
  persistence: number;
  fan: number;
  /** nvmlGpuP2PStatus_t of the read and of the write capability, between any two cards. */
  p2pRead: number;
  p2pWrite: number;
}

/**
 * A fake libnvidia-ml over `cards`. Every call is counted by name and card (`<symbol>@<uuid>`, the system's calls by
 * name alone, the PCIe throughput as `PcieRx` and `PcieTx`, peer-to-peer as `P2pRead` and `P2pWrite` on the card it
 * starts from); `rcs` scripts the return codes of a call, one per call
 * in order, then success. `live` holds what the slow calls and the fan answer, the same for every card.
 */
const fakeNvml = (cards: ReadonlyArray<FakeCard>, rcs: Record<string, Array<number>> = {}) => {
  const live: LiveValues = {
    pcieRx: 100,
    pcieTx: 50,
    powerLimit: 300_000,
    persistence: 1,
    fan: 30,
    p2pRead: 0,
    p2pWrite: 0,
  };
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
    (value: number | (() => number)) =>
    (_: FakeCard, out: Buffer): void => {
      out.writeUInt32LE(typeof value === 'number' ? value : value(), 0);
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
    nvmlDeviceGetPowerManagementLimit: on(
      'PowerManagementLimit',
      u32(() => live.powerLimit),
    ),
    nvmlDeviceGetPowerManagementDefaultLimit: on('PowerManagementDefaultLimit', u32(285_000)),
    nvmlDeviceGetPersistenceMode: on(
      'PersistenceMode',
      u32(() => live.persistence),
    ),
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
    nvmlDeviceGetFanSpeed: on(
      'FanSpeed',
      u32(() => live.fan),
    ),
    nvmlDeviceGetPcieThroughput: (h, counter, out) =>
      on(
        counter === 1 ? 'PcieRx' : 'PcieTx',
        u32(() => (counter === 1 ? live.pcieRx : live.pcieTx)),
      )(h, out),
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
    nvmlDeviceGetP2PStatus: (from, to, capability, out) =>
      byHandle.has(to)
        ? on(
            capability === 0 ? 'P2pRead' : 'P2pWrite',
            u32(() => (capability === 0 ? live.p2pRead : live.p2pWrite)),
          )(from, out)
        : 2,
  };
  const of = (call: string, card?: FakeCard): number =>
    calls.get(card === undefined ? call : `${call}@${card.uuid}`) ?? 0;
  return { lib, of, live };
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
/** The calls of a card made on every sample (the clocks twice: graphics and memory). */
const SAMPLE_CALLS: Record<string, number> = {
  MemoryInfo: 1,
  UtilizationRates: 1,
  Temperature: 1,
  PowerUsage: 1,
  ClockInfo: 2,
  FanSpeed: 1,
  CurrPcieLinkGeneration: 1,
  CurrPcieLinkWidth: 1,
  ComputeRunningProcesses: 1,
};
/** The calls of a card made again once 5 s have passed since their last read. */
const PCIE_CALLS = ['PcieRx', 'PcieTx'];
/** The calls of a card made again once 10 s have passed since their last read. */
const LIMIT_CALLS = ['PowerManagementLimit', 'PersistenceMode'];

/** The calls of a card made once for each other card. */
const P2P_CALLS = ['P2pRead', 'P2pWrite'];

/** Peer-to-peer the driver allows, to each of the two fake cards. */
const TO_A: GpuPeer = { busId: '0000:01:00.0', status: 'ok' };
const TO_B: GpuPeer = { busId: '0000:0d:00.0', status: 'ok' };

const ALL: GpuNeeds = { skipGpus: [] };

/** One sample at each time of `at` (ms), in order. */
const sampleAt = (read: NvmlSample, at: ReadonlyArray<number>, needs: GpuNeeds = ALL): Array<NvmlSnapshot> =>
  Arr.map(at, (t) => read(needs, t));

/** How many times each of `calls` was made on `card`. */
const countsOf = (nvml: ReturnType<typeof fakeNvml>, calls: ReadonlyArray<string>, card: FakeCard) =>
  Arr.map(calls, (call) => nvml.of(call, card));

/** The one card of a sample. */
const only = (snapshot: NvmlSnapshot | undefined): GpuReading => {
  const g = snapshot?.gpus[0];
  assert.isDefined(g);
  return g;
};

describe('the NVML reader', () => {
  it('reads what does not change once, the slow values once per period, and the rest on every sample', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const samples = sampleAt(read, [0, 1000, 2000]);
    for (const card of [CARD_A, CARD_B]) {
      for (const call of STATIC_CALLS) assert.strictEqual(nvml.of(call, card), 1, `${call} of ${card.uuid}`);
      for (const [call, n] of Record.toEntries(SAMPLE_CALLS))
        assert.strictEqual(nvml.of(call, card), 3 * n, `${call} of ${card.uuid}`);
      for (const call of [...PCIE_CALLS, ...LIMIT_CALLS])
        assert.strictEqual(nvml.of(call, card), 1, `${call} of ${card.uuid}`);
    }
    assert.strictEqual(nvml.of('DriverVersion'), 1);
    assert.strictEqual(nvml.of('CudaDriverVersion'), 1);
    for (const snapshot of samples)
      assert.deepStrictEqual(snapshot, {
        gpus: [
          fullReading('nvidia:GPU-a', '0000:01:00.0', [TO_B]),
          fullReading('nvidia:GPU-b', '0000:0d:00.0', [TO_A]),
        ],
        procs: [{ pid: 4242, key: 'nvidia:GPU-a', usedBytes: GiB }],
        system: { driver: '580.95.05', cudaDriver: 13000 },
      });
  });

  it('reads the PCIe throughput on the first sample, then again once 5 s have passed', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    read(ALL, 0);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [1, 1]);
    sampleAt(read, [1000, 2000, 3000, 4000, 4999]);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [1, 1], 'not before 5 s');
    read(ALL, 5000);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [2, 2], 'at 5 s');
    sampleAt(read, [6000, 9999]);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [2, 2]);
    read(ALL, 10_000);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [3, 3], '5 s after the last read');
  });

  it('reads the power limit and the persistence mode on the first sample, then again once 10 s have passed', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    read(ALL, 0);
    assert.deepStrictEqual(countsOf(nvml, LIMIT_CALLS, CARD_A), [1, 1]);
    sampleAt(read, [1000, 5000, 9000, 9999]);
    assert.deepStrictEqual(countsOf(nvml, LIMIT_CALLS, CARD_A), [1, 1], 'not before 10 s');
    read(ALL, 10_000);
    assert.deepStrictEqual(countsOf(nvml, LIMIT_CALLS, CARD_A), [2, 2], 'at 10 s');
    sampleAt(read, [15_000, 19_999]);
    assert.deepStrictEqual(countsOf(nvml, LIMIT_CALLS, CARD_A), [2, 2]);
    read(ALL, 20_000);
    assert.deepStrictEqual(countsOf(nvml, LIMIT_CALLS, CARD_A), [3, 3], '10 s after the last read');
  });

  it('reads the fan speed on every sample', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    const fans = Arr.map([0, 100, 200, 300], (t, i) => {
      nvml.live.fan = 30 + i;
      return only(read(ALL, t)).fanPct;
    });
    assert.deepStrictEqual(fans, [30, 31, 32, 33]);
    assert.strictEqual(nvml.of('FanSpeed', CARD_A), 4);
  });

  it('reports the value it last read between two reads, every field of the reading kept', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    read(ALL, 0);
    Object.assign(nvml.live, { pcieRx: 700, pcieTx: 400, powerLimit: 250_000, persistence: 0 });
    assert.deepStrictEqual(read(ALL, 4000).gpus, [fullReading('nvidia:GPU-a', '0000:01:00.0')]);
    const pcieDue = only(read(ALL, 5000));
    assert.deepStrictEqual(
      [pcieDue.pcieRxBps, pcieDue.pcieTxBps, pcieDue.powerLimitW, pcieDue.persistence],
      [700 * 1024, 400 * 1024, 300, true],
    );
    const limitsDue = only(read(ALL, 10_000));
    assert.deepStrictEqual(
      [limitsDue.pcieRxBps, limitsDue.pcieTxBps, limitsDue.powerLimitW, limitsDue.persistence],
      [700 * 1024, 400 * 1024, 250, false],
    );
  });

  it('reads every value on every sample when the interval is longer than the periods', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    sampleAt(read, [0, 12_000, 24_000, 36_000]);
    assert.deepStrictEqual(countsOf(nvml, [...PCIE_CALLS, ...LIMIT_CALLS, 'FanSpeed'], CARD_A), [4, 4, 4, 4, 4]);
  });

  it('reads the slow values again when the clock goes back', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    sampleAt(read, [60_000, 61_000, 2000, 3000]);
    assert.deepStrictEqual(countsOf(nvml, [...PCIE_CALLS, ...LIMIT_CALLS], CARD_A), [2, 2, 2, 2]);
  });

  it('identifies a hidden card without reading it, and reads it in full once it is shown', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const hidden = { skipGpus: ['0000:0d:00.0'] };
    const [first] = sampleAt(read, [0, 1000], hidden);
    assert.deepStrictEqual(
      first?.gpus[1],
      identityReading(
        { key: 'nvidia:GPU-b', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070 Ti', busId: '0000:0d:00.0' },
        'hidden',
      ),
    );
    for (const call of ['UUID', 'Name', 'PciInfo']) assert.strictEqual(nvml.of(call, CARD_B), 1, call);
    for (const call of [
      'MaxClockInfo',
      'PowerManagementDefaultLimit',
      ...Record.keys(SAMPLE_CALLS),
      ...PCIE_CALLS,
      ...LIMIT_CALLS,
    ])
      assert.strictEqual(nvml.of(call, CARD_B), 0, call);
    const shown = read(ALL, 2000);
    assert.deepStrictEqual(shown.gpus[1], fullReading('nvidia:GPU-b', '0000:0d:00.0', [TO_A]));
    assert.strictEqual(nvml.of('MaxClockInfo', CARD_B), 1);
  });

  it('reads once what the driver allows from each card to the others, read and write', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    for (const snapshot of sampleAt(read, [0, 1000, 2000])) {
      assert.deepStrictEqual(snapshot.gpus[0]?.p2p, [TO_B]);
      assert.deepStrictEqual(snapshot.gpus[1]?.p2p, [TO_A]);
    }
    for (const card of [CARD_A, CARD_B])
      assert.deepStrictEqual(countsOf(nvml, P2P_CALLS, card), [1, 1], `peer-to-peer of ${card.uuid}`);
  });

  it('reports no peer-to-peer for a card alone', () => {
    const nvml = fakeNvml([CARD_A]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    assert.isFalse('p2p' in only(read(ALL, 0)));
    assert.deepStrictEqual(countsOf(nvml, P2P_CALLS, CARD_A), [0, 0]);
  });

  it('names what stands in the way of peer-to-peer, the read before the write', () => {
    const statusOf = (p2pRead: number, p2pWrite: number) => {
      const nvml = fakeNvml([CARD_A, CARD_B]);
      Object.assign(nvml.live, { p2pRead, p2pWrite });
      return nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]))(ALL, 0).gpus[0]?.p2p?.[0]?.status;
    };
    assert.deepStrictEqual(
      [statusOf(0, 1), statusOf(0, 2), statusOf(3, 2), statusOf(4, 0), statusOf(0, 5), statusOf(6, 0), statusOf(0, 42)],
      ['chipset', 'gpu', 'topology', 'disabled', 'unsupported', 'unknown', 'unknown'],
    );
  });

  it('leaves out a peer the driver does not answer for, and asks again on the next sample', () => {
    const nvml = fakeNvml([CARD_A, CARD_B], { 'P2pWrite@GPU-a': [UNKNOWN] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const [first, second] = sampleAt(read, [0, 1000, 2000]);
    assert.isFalse('p2p' in (first?.gpus[0] ?? {}), 'a failure is not a refusal');
    assert.deepStrictEqual(first?.gpus[1]?.p2p, [TO_A]);
    assert.deepStrictEqual(second?.gpus[0]?.p2p, [TO_B]);
    assert.deepStrictEqual(countsOf(nvml, P2P_CALLS, CARD_A), [2, 2]);
  });

  it('asks nothing about peer-to-peer with a hidden card, in either direction', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    const [first] = sampleAt(read, [0, 1000], { skipGpus: ['0000:0d:00.0'] });
    assert.isFalse('p2p' in (first?.gpus[0] ?? {}));
    for (const card of [CARD_A, CARD_B]) assert.deepStrictEqual(countsOf(nvml, P2P_CALLS, card), [0, 0]);
    assert.deepStrictEqual(read(ALL, 2000).gpus[0]?.p2p, [TO_B]);
  });

  it('reads a card in full on the first sample it is shown again, within the periods', () => {
    const nvml = fakeNvml([CARD_A, CARD_B]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A, CARD_B]));
    read(ALL, 0);
    read({ skipGpus: ['0000:0d:00.0'] }, 1000);
    Object.assign(nvml.live, { pcieRx: 700, pcieTx: 400, powerLimit: 250_000, persistence: 0 });
    const [a, b] = read(ALL, 2000).gpus;
    assert.deepStrictEqual(countsOf(nvml, [...PCIE_CALLS, ...LIMIT_CALLS], CARD_B), [2, 2, 2, 2]);
    assert.deepStrictEqual(
      [b?.pcieRxBps, b?.pcieTxBps, b?.powerLimitW, b?.persistence],
      [700 * 1024, 400 * 1024, 250, false],
    );
    assert.deepStrictEqual(countsOf(nvml, [...PCIE_CALLS, ...LIMIT_CALLS], CARD_A), [1, 1, 1, 1]);
    assert.deepStrictEqual(
      [a?.pcieRxBps, a?.powerLimitW],
      [100 * 1024, 300],
      'a card that stayed shown keeps its values',
    );
  });

  it('reports a slow value that fails as unknown, and asks it again on the next sample', () => {
    const nvml = fakeNvml([CARD_A], {
      'PcieRx@GPU-a': [UNKNOWN],
      'PowerManagementLimit@GPU-a': [SUCCESS, UNKNOWN],
    });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    const first = only(read(ALL, 0));
    assert.deepStrictEqual([first.pcieRxBps, first.pcieTxBps], [null, 50 * 1024]);
    const second = only(read(ALL, 1000));
    assert.strictEqual(second.pcieRxBps, 100 * 1024, 'asked again on the next sample');
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [2, 1]);
    read(ALL, 2000);
    assert.deepStrictEqual(countsOf(nvml, PCIE_CALLS, CARD_A), [2, 1], 'kept once read');
    assert.strictEqual(only(read(ALL, 10_000)).powerLimitW, null, 'a failure does not report the value before it');
    assert.strictEqual(only(read(ALL, 11_000)).powerLimitW, 300);
    read(ALL, 12_000);
    assert.strictEqual(nvml.of('PowerManagementLimit', CARD_A), 3);
  });

  it('keeps for its period the answer that the card does not support a slow value', () => {
    const nvml = fakeNvml([CARD_A], { 'PcieTx@GPU-a': [NOT_SUPPORTED] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    for (const s of sampleAt(read, [0, 1000, 4999])) assert.strictEqual(only(s).pcieTxBps, null);
    assert.strictEqual(nvml.of('PcieTx', CARD_A), 1);
    assert.strictEqual(only(read(ALL, 5000)).pcieTxBps, 50 * 1024);
  });

  it('asks a value that does not change again after a failure, and keeps it once read', () => {
    const nvml = fakeNvml([CARD_A], {
      'UUID@GPU-a': [UNKNOWN],
      'Name@GPU-a': [UNKNOWN],
      'MaxClockInfo@GPU-a': [UNKNOWN],
      DriverVersion: [UNKNOWN],
    });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    const [first, second, third] = sampleAt(read, [0, 1000, 2000, 3000]);
    assert.deepStrictEqual(first?.gpus, [], 'a card without its UUID is left out of the sample');
    assert.strictEqual(first?.system.driver, null);
    assert.strictEqual(second?.gpus[0]?.name, 'NVIDIA GPU', 'the name of a card that refuses it');
    assert.strictEqual(second?.gpus[0]?.clockGrMaxMhz, null);
    assert.strictEqual(second?.system.driver, '580.95.05');
    assert.deepStrictEqual(third?.gpus, [fullReading('nvidia:GPU-a', '0000:01:00.0')]);
    assert.deepStrictEqual(
      [nvml.of('UUID', CARD_A), nvml.of('Name', CARD_A), nvml.of('MaxClockInfo', CARD_A), nvml.of('DriverVersion')],
      [2, 2, 2, 2],
    );
  });

  it('does not ask again for a value the card does not support', () => {
    const nvml = fakeNvml([CARD_A], { 'PowerManagementDefaultLimit@GPU-a': [NOT_SUPPORTED] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    for (const s of sampleAt(read, [0, 1000, 2000])) assert.strictEqual(s.gpus[0]?.powerDefaultLimitW, null);
    assert.strictEqual(nvml.of('PowerManagementDefaultLimit', CARD_A), 1);
  });

  it('lists every process of a card, beyond what the first buffer holds, on every sample', () => {
    const pids = Array.from({ length: 70 }, (_, i) => 1000 + i);
    const nvml = fakeNvml([{ ...CARD_A, pids }]);
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    for (const s of sampleAt(read, [0, 1000]))
      assert.deepStrictEqual(
        Arr.map(s.procs, (p) => p.pid),
        pids,
      );
  });

  it('leaves out the processes of a card that refuses them, and reads them at the next sample', () => {
    const nvml = fakeNvml([CARD_A], { 'ComputeRunningProcesses@GPU-a': [UNKNOWN] });
    const read = nvmlReader(nvml.lib, handlesOf([CARD_A]));
    assert.deepStrictEqual(read(ALL, 0).procs, []);
    assert.deepStrictEqual(read(ALL, 1000).procs, [{ pid: 4242, key: 'nvidia:GPU-a', usedBytes: GiB }]);
  });
});
