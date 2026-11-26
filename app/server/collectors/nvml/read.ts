import type { GpuP2pStatus, GpuPeer, GpuReading } from '@llama-webui/shared';
import { Array as Arr, Record } from 'effect';
import { dual } from 'effect/Function';
import { type GpuNeeds, gpuSkipped, identityReading, normalizeBusId } from '../gpu.ts';
import type { NvmlProc, NvmlSnapshot, NvmlSystem } from './protocol.ts';
import type { NvmlSymbols } from './symbols.ts';

/*
 * The readings of NVML, by the C structures it fills. Synchronous calls into the driver: the sampler (`worker.ts`)
 * makes them in a process of its own, never the server.
 */

/** NVML_VALUE_NOT_AVAILABLE for unsigned long long fields. */
const VALUE_NOT_AVAILABLE = 0xffffffffffffffffn;

const SUCCESS = 0;
const NOT_SUPPORTED = 3;
const INSUFFICIENT_SIZE = 7;
const STR_LEN = 96;
const MEMORY_V2_SIZE = 40;
const MEMORY_V2_VERSION = MEMORY_V2_SIZE | (2 << 24);
const PCI_INFO_SIZE = 68;
const PCI_BUS_ID_OFFSET = 36;
const PROC_INFO_SIZE = 24;
const PROC_CAP = 64;
const CLOCK_GRAPHICS = 0;
const CLOCK_MEM = 2;
const PCIE_TX = 0;
const PCIE_RX = 1;
/** nvmlGpuP2PCapsIndex_t: the read and the write capability, what `nvidia-smi topo -p2p rw` asks. */
const P2P_CAPABILITIES = [0, 1] as const;
/** nvmlGpuP2PStatus_t, by value. */
const P2P_STATUS: ReadonlyArray<GpuP2pStatus> = [
  'ok',
  'chipset',
  'gpu',
  'topology',
  'disabled',
  'unsupported',
  'unknown',
];

/**
 * How long the PCIe throughput read is kept. Each counter blocks about 20 ms per card in the driver (rx and tx: about
 * 40 ms of wall and 2 to 5 ms of CPU per card), and what shows it does not need it every second: the System page's GPU
 * card, the Topology page's link streaks and the monitor's `pcieRx`/`pcieTx` history hold it for up to this long.
 */
export const PCIE_THROUGHPUT_PERIOD_MS = 5_000;

/**
 * How long the power limit and the persistence mode are kept. A person changes them (`nvidia-smi -pl`, `-pm`), not
 * the load: the System page's GPU card shows the limit, and the tuning checks read both, which the page reloads every
 * 10 s; each read is up to 2 ms of CPU in the driver.
 */
export const LIMITS_PERIOD_MS = 10_000;

/** The NUL-terminated string at `from` of `buf`, `to` at most. */
const cString = (buf: Buffer, from = 0, to = buf.length): string => {
  const end = buf.indexOf(0, from);
  return buf.toString('utf8', from, end < 0 || end > to ? to : end);
};

/** The handle of each device NVML gives; the ones it refuses are left out. */
export const deviceHandles = (lib: NvmlSymbols): ReadonlyArray<bigint> => {
  const count = Buffer.alloc(4);
  if (lib.nvmlDeviceGetCount_v2(count) !== SUCCESS) return [];
  const handles: Array<bigint> = [];
  const out = Buffer.alloc(8);
  for (let i = 0; i < count.readUInt32LE(0); i++) {
    if (lib.nvmlDeviceGetHandleByIndex_v2(i, out) === SUCCESS) handles.push(out.readBigUInt64LE(0));
  }
  return handles;
};

/** One sample of the cards at `nowMs`, the time in ms of the sampler's clock. */
export type NvmlSample = (needs: GpuNeeds, nowMs: number) => NvmlSnapshot;

/** What a call answered: its return code, and the value it gave (the fallback when it gave none). */
interface Answer<A> {
  readonly rc: number;
  readonly value: A;
}

/**
 * A value that does not change (a card's identity and maxima, the driver's versions), asked on first use: kept once
 * NVML gives it, or says the card has none (`NVML_ERROR_NOT_SUPPORTED`); any other failure answers the fallback and
 * is asked again on the next use, as when every sample read it.
 */
const once = <A>(ask: () => Answer<A>): (() => A) => {
  let kept: Answer<A> | undefined;
  return () => {
    if (kept !== undefined) return kept.value;
    const answer = ask();
    if (answer.rc === SUCCESS || answer.rc === NOT_SUPPORTED) kept = answer;
    return answer.value;
  };
};

/** A value read again once its period has passed (`every`). */
interface Periodic<A> {
  /** The value at `nowMs`: the one last read while its period runs, else read again. */
  readonly at: (nowMs: number) => A;
  /** Drops the value: the next `at` reads it. */
  readonly forget: () => void;
}

/**
 * A value read again only once `periodMs` has passed since its last read (or when the clock went back); in between,
 * the value last read. It is kept once NVML gives it, or says the card has none (`NVML_ERROR_NOT_SUPPORTED`); any
 * other failure answers the fallback, keeps nothing, and is asked again on the next sample: a value is never carried
 * over a failure.
 */
const every = <A>(periodMs: number, ask: () => Answer<A>): Periodic<A> => {
  let kept: { readonly readAt: number; readonly value: A } | undefined;
  return {
    at: (nowMs) => {
      if (kept !== undefined) {
        const elapsed = nowMs - kept.readAt;
        if (elapsed >= 0 && elapsed < periodMs) return kept.value;
      }
      const answer = ask();
      kept = answer.rc === SUCCESS || answer.rc === NOT_SUPPORTED ? { readAt: nowMs, value: answer.value } : undefined;
      return answer.value;
    },
    forget: () => {
      kept = undefined;
    },
  };
};

/**
 * The reader of the cards of `handles`. Each call is one sample at `nowMs` (the sampler's clock): one reading per
 * card, and the processes on it; cards `needs` skips are only identified (UUID, name, bus id). What does not change is
 * read on the first sample that needs it, then kept (`once`); the PCIe throughput, the power limit and the persistence
 * mode are read again once their period has passed (`every`), and a card's first sample after it was hidden reads them
 * all. Peer-to-peer is what the driver allows from a card to each other card read, asked once per pair and direction:
 * it is the same with or without a program on the cards. The buffers NVML fills are the reader's, reused by every
 * sample.
 */
export const nvmlReader: {
  (handles: ReadonlyArray<bigint>): (lib: NvmlSymbols) => NvmlSample;
  (lib: NvmlSymbols, handles: ReadonlyArray<bigint>): NvmlSample;
} = dual(2, (lib: NvmlSymbols, handles: ReadonlyArray<bigint>): NvmlSample => {
  const str = Buffer.alloc(STR_LEN);
  const u32 = Buffer.alloc(4);
  const pci = Buffer.alloc(PCI_INFO_SIZE);
  const mem = Buffer.alloc(MEMORY_V2_SIZE);
  const util = Buffer.alloc(8);
  const procCount = Buffer.alloc(4);
  let procCap = PROC_CAP;
  let procInfos = Buffer.alloc(procCap * PROC_INFO_SIZE);

  const readU32 = (rc: number, mul = 1, div = 1): number | null =>
    rc === SUCCESS ? (u32.readUInt32LE(0) * mul) / div : null;
  const answerU32 = (rc: number, mul = 1, div = 1): Answer<number | null> => ({ rc, value: readU32(rc, mul, div) });
  const answerStr = <A>(rc: number, fallback: A): Answer<string | A> => ({
    rc,
    value: rc === SUCCESS ? cString(str) : fallback,
  });

  const system = {
    driver: once(() => answerStr(lib.nvmlSystemGetDriverVersion(str.fill(0), STR_LEN), null)),
    cudaDriver: once(() => {
      const rc = lib.nvmlSystemGetCudaDriverVersion(u32);
      return { rc, value: rc === SUCCESS ? u32.readInt32LE(0) : null };
    }),
  };
  const cards = Arr.map(handles, (h) => ({
    h,
    uuid: once(() => answerStr(lib.nvmlDeviceGetUUID(h, str.fill(0), STR_LEN), null)),
    name: once(() => answerStr(lib.nvmlDeviceGetName(h, str.fill(0), STR_LEN), 'NVIDIA GPU')),
    busId: once(() => {
      const rc = lib.nvmlDeviceGetPciInfo_v3(h, pci.fill(0));
      return { rc, value: rc === SUCCESS ? normalizeBusId(cString(pci, PCI_BUS_ID_OFFSET, PCI_INFO_SIZE)) : '' };
    }),
    clockGrMaxMhz: once(() => answerU32(lib.nvmlDeviceGetMaxClockInfo(h, CLOCK_GRAPHICS, u32))),
    pcieGenMax: once(() => answerU32(lib.nvmlDeviceGetMaxPcieLinkGeneration(h, u32))),
    pcieWidthMax: once(() => answerU32(lib.nvmlDeviceGetMaxPcieLinkWidth(h, u32))),
    powerDefaultLimitW: once(() => answerU32(lib.nvmlDeviceGetPowerManagementDefaultLimit(h, u32), 1, 1000)),
    slow: {
      pcieRxBps: every(PCIE_THROUGHPUT_PERIOD_MS, () =>
        answerU32(lib.nvmlDeviceGetPcieThroughput(h, PCIE_RX, u32), 1024),
      ),
      pcieTxBps: every(PCIE_THROUGHPUT_PERIOD_MS, () =>
        answerU32(lib.nvmlDeviceGetPcieThroughput(h, PCIE_TX, u32), 1024),
      ),
      powerLimitW: every(LIMITS_PERIOD_MS, () => answerU32(lib.nvmlDeviceGetPowerManagementLimit(h, u32), 1, 1000)),
      persistence: every(LIMITS_PERIOD_MS, () => answerU32(lib.nvmlDeviceGetPersistenceMode(h, u32))),
    },
  }));

  /**
   * Peer-to-peer from the card `from` to the card `to`: `ok` when the driver allows it to read and to write there, else
   * the first status that stands in the way; null when the driver does not answer.
   */
  const p2pStatus = (from: bigint, to: bigint): Answer<GpuP2pStatus | null> => {
    for (const capability of P2P_CAPABILITIES) {
      const rc = lib.nvmlDeviceGetP2PStatus(from, to, capability, u32);
      if (rc !== SUCCESS) return { rc, value: null };
      const status = P2P_STATUS[u32.readUInt32LE(0)] ?? 'unknown';
      if (status !== 'ok') return { rc, value: status };
    }
    return { rc: SUCCESS, value: 'ok' };
  };
  /** By card, in the order of `cards`: each other card, and peer-to-peer to it. */
  const peers = Arr.map(cards, (card) =>
    Arr.flatMap(cards, (other) => (other === card ? [] : [{ other, status: once(() => p2pStatus(card.h, other.h)) }])),
  );
  /** Peer-to-peer from the card at `index` to the cards `needs` reads; a card the driver does not answer for is left out. */
  const readPeers = (index: number, needs: GpuNeeds): Array<GpuPeer> =>
    Arr.flatMap(peers[index] ?? [], ({ other, status }) => {
      if (other.uuid() === null) return [];
      const busId = other.busId();
      // A hidden card is listed, not read: nothing is asked about it either.
      if (gpuSkipped(needs, busId)) return [];
      const answer = status();
      return answer === null ? [] : [{ busId, status: answer }];
    });

  /** The compute processes on a card; none when NVML refuses. */
  const readProcs = (h: bigint, key: string, into: Array<NvmlProc>): void => {
    for (let attempt = 0; attempt < 2; attempt++) {
      procCount.writeUInt32LE(procCap, 0);
      const rc = lib.nvmlDeviceGetComputeRunningProcesses_v3(h, procCount, procInfos);
      if (rc === INSUFFICIENT_SIZE) {
        procCap = procCount.readUInt32LE(0) + 8; // processes may appear between the two calls
        procInfos = Buffer.alloc(procCap * PROC_INFO_SIZE);
        continue;
      }
      if (rc !== SUCCESS) return;
      const n = Math.min(procCount.readUInt32LE(0), procCap);
      for (let i = 0; i < n; i++) {
        const used = procInfos.readBigUInt64LE(i * PROC_INFO_SIZE + 8);
        into.push({
          pid: procInfos.readUInt32LE(i * PROC_INFO_SIZE),
          key,
          usedBytes: used === VALUE_NOT_AVAILABLE ? null : Number(used),
        });
      }
      return;
    }
  };

  return (needs, nowMs) => {
    const gpus: Array<GpuReading> = [];
    const procs: Array<NvmlProc> = [];
    for (const [index, card] of cards.entries()) {
      const { h } = card;
      const uuid = card.uuid();
      if (uuid === null) continue;
      const key = `nvidia:${uuid}`;
      const name = card.name();
      const busId = card.busId();
      const { slow } = card;
      if (gpuSkipped(needs, busId)) {
        // Shown again, the card is read in full, not with values from before it was hidden.
        for (const value of Record.values(slow)) value.forget();
        gpus.push(identityReading({ key, vendor: 'nvidia', name, busId }, 'hidden'));
        continue;
      }

      mem.writeUInt32LE(MEMORY_V2_VERSION, 0);
      const memOk = lib.nvmlDeviceGetMemoryInfo_v2(h, mem) === SUCCESS; // unknown VRAM reads as 0, the GPU stays listed
      const utilOk = lib.nvmlDeviceGetUtilizationRates(h, util) === SUCCESS;
      const persistence = slow.persistence.at(nowMs);
      const p2p = readPeers(index, needs);

      gpus.push({
        key,
        vendor: 'nvidia',
        name,
        busId,
        utilPct: utilOk ? util.readUInt32LE(0) : null,
        memUtilPct: utilOk ? util.readUInt32LE(4) : null,
        vramUsedBytes: memOk ? Number(mem.readBigUInt64LE(32)) : 0,
        vramTotalBytes: memOk ? Number(mem.readBigUInt64LE(8)) : 0,
        tempC: readU32(lib.nvmlDeviceGetTemperature(h, 0, u32)),
        powerW: readU32(lib.nvmlDeviceGetPowerUsage(h, u32), 1, 1000),
        powerLimitW: slow.powerLimitW.at(nowMs),
        powerDefaultLimitW: card.powerDefaultLimitW(),
        persistence: persistence === null ? null : persistence === 1,
        clockGrMhz: readU32(lib.nvmlDeviceGetClockInfo(h, CLOCK_GRAPHICS, u32)),
        clockGrMaxMhz: card.clockGrMaxMhz(),
        clockMemMhz: readU32(lib.nvmlDeviceGetClockInfo(h, CLOCK_MEM, u32)),
        fanPct: readU32(lib.nvmlDeviceGetFanSpeed(h, u32)),
        pcieGen: readU32(lib.nvmlDeviceGetCurrPcieLinkGeneration(h, u32)),
        pcieWidth: readU32(lib.nvmlDeviceGetCurrPcieLinkWidth(h, u32)),
        pcieGenMax: card.pcieGenMax(),
        pcieWidthMax: card.pcieWidthMax(),
        pcieRxBps: slow.pcieRxBps.at(nowMs),
        pcieTxBps: slow.pcieTxBps.at(nowMs),
        ...(Arr.isArrayNonEmpty(p2p) ? { p2p } : {}),
      });
      readProcs(h, key, procs);
    }
    const versions: NvmlSystem = { driver: system.driver(), cudaDriver: system.cudaDriver() };
    return { gpus, procs, system: versions };
  };
});
