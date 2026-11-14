import type {
  DiskSample,
  GpuSample,
  RequestRecord,
  RequestStats,
  SlotView,
  SpecStats,
  SystemSample,
} from '@llama-webui/shared';
import { Array as Arr, Record } from 'effect';

/*
 * Every number of a snapshot is finite (`Schema.Finite`, `Schema.Int`): the hub drops a message that does not encode.
 * A reading that is not finite (a counter that went backwards, a rate over a zero interval) is sent as null where the
 * field allows it, else as 0; an integral field takes the integral part of a finite value.
 */

export const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

export const finiteOrNull = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null);

export const int = (v: number): number => {
  const n = Math.trunc(v);
  return Number.isSafeInteger(n) ? n : 0;
};

export const intOrNull = (v: number | null): number | null => {
  if (v === null) return null;
  const n = Math.trunc(v);
  return Number.isSafeInteger(n) ? n : null;
};

/** The optional readings of a card, each finite or null when present; absent stays absent. */
const DETAILS = [
  'memUtilPct',
  'fanPct',
  'powerLimitW',
  'powerDefaultLimitW',
  'clockGrMhz',
  'clockGrMaxMhz',
  'clockMemMhz',
  'pcieGen',
  'pcieWidth',
  'pcieGenMax',
  'pcieWidthMax',
  'pcieRxBps',
  'pcieTxBps',
] as const;

export const finiteGpu = (g: GpuSample): GpuSample => {
  const details = Record.fromEntries(
    Arr.flatMap(DETAILS, (key) => {
      const v = g[key];
      return v === undefined ? [] : [[key, finiteOrNull(v)] as const];
    }),
  );
  return {
    ...g,
    ...details,
    utilPct: finiteOrNull(g.utilPct),
    vramUsedBytes: finite(g.vramUsedBytes),
    vramTotalBytes: finite(g.vramTotalBytes),
    tempC: finiteOrNull(g.tempC),
    powerW: finiteOrNull(g.powerW),
    procVramBytes: finite(g.procVramBytes),
  };
};

export const finiteSystem = (s: SystemSample): SystemSample => ({
  ...s,
  cpuPct: finite(s.cpuPct),
  corePct: Arr.map(s.corePct, finite),
  freqMhz: finiteOrNull(s.freqMhz),
  tempC: finiteOrNull(s.tempC),
  load: s.load === null ? null : [finite(s.load[0]), finite(s.load[1]), finite(s.load[2])],
  mem:
    s.mem === null
      ? null
      : {
          totalBytes: finite(s.mem.totalBytes),
          availableBytes: finite(s.mem.availableBytes),
          cachedBytes: finite(s.mem.cachedBytes),
          swapTotalBytes: finite(s.mem.swapTotalBytes),
          swapUsedBytes: finite(s.mem.swapUsedBytes),
        },
  ...(s.memBw === undefined
    ? {}
    : { memBw: s.memBw === null ? null : { readBps: finite(s.memBw.readBps), writeBps: finite(s.memBw.writeBps) } }),
});

const finiteRates = (r: { readonly readBps: number; readonly writeBps: number }) => ({
  readBps: finite(r.readBps),
  writeBps: finite(r.writeBps),
});

export const finiteDisk = (d: DiskSample): DiskSample => ({
  ...finiteRates(d),
  perDisk: Record.map(d.perDisk, finiteRates),
  model: d.model === null ? null : { disk: d.model.disk, readBps: finite(d.model.readBps) },
});

export const finiteSlot = (s: SlotView): SlotView => ({
  id: int(s.id),
  nCtx: int(s.nCtx),
  processing: s.processing,
  idTask: intOrNull(s.idTask),
  nPromptTokens: int(s.nPromptTokens),
  nPromptProcessed: int(s.nPromptProcessed),
  nDecoded: int(s.nDecoded),
  nRemain: intOrNull(s.nRemain),
});

export const finiteRequestStats = (r: RequestStats): RequestStats => ({
  genTps: finiteOrNull(r.genTps),
  ppTps: finiteOrNull(r.ppTps),
  specAccept: finiteOrNull(r.specAccept),
});

export const finiteSpec = (s: SpecStats): SpecStats => ({
  acceptCum: finiteOrNull(s.acceptCum),
  drafts: finite(s.drafts),
  draftTokens: finite(s.draftTokens),
  accepted: finite(s.accepted),
  meanAcceptedPerDraft: finiteOrNull(s.meanAcceptedPerDraft),
  perPos: Arr.map(s.perPos, finite),
});

export const finiteRecord = (r: RequestRecord): RequestRecord => ({
  at: int(r.at),
  promptTokens: finite(r.promptTokens),
  cachedTokens: finite(r.cachedTokens),
  genTokens: finite(r.genTokens),
  promptSec: finiteOrNull(r.promptSec),
  genSec: finiteOrNull(r.genSec),
  ppTps: finiteOrNull(r.ppTps),
  genTps: finiteOrNull(r.genTps),
  specAccept: finiteOrNull(r.specAccept),
});
