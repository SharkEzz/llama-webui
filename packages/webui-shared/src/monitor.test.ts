import { Effect, Exit, Schema } from 'effect';
import type * as Metrics from 'llamacpp-js/metrics';
import { expect, expectTypeOf, test } from 'vitest';
import {
  type Health,
  type RequestRecord,
  type RequestStats,
  type SlotView,
  Snapshot,
  type SpecStats,
} from './monitor.ts';
import { WsMessage } from './ws.ts';

test('the metrics schemas take what llamacpp-js produces', () => {
  expectTypeOf<Metrics.SlotView>().toExtend<SlotView>();
  expectTypeOf<Metrics.RequestStats>().toExtend<RequestStats>();
  expectTypeOf<Metrics.SpecStats>().toExtend<SpecStats>();
  expectTypeOf<Metrics.RequestRecord>().toExtend<RequestRecord>();
  expectTypeOf<Metrics.Health>().toExtend<Health>();
});

const snapshot: Snapshot = {
  at: 1_700_000_000_000,
  tick: 3,
  health: 'ok',
  rates: { genTps: 12.5, ppTps: 0 },
  slots: [
    {
      id: 0,
      nCtx: 8192,
      processing: true,
      idTask: 7,
      nPromptTokens: 120,
      nPromptProcessed: 100,
      nDecoded: 20,
      nRemain: null,
    },
  ],
  kv: { usedTokens: 120, totalTokens: 8192 },
  queue: { processing: 1, deferred: 0, busySlots: 1 },
  lastRequest: { genTps: 12.5, ppTps: null, specAccept: null },
  spec: null,
  recentRequests: [],
  gpus: [
    {
      key: 'nvidia:GPU-0',
      vendor: 'nvidia',
      name: 'Test GPU',
      busId: '0000:01:00.0',
      utilPct: 40,
      vramUsedBytes: 1024,
      vramTotalBytes: 4096,
      tempC: null,
      powerW: 80.5,
      procVramBytes: 512,
      // Detailed fields: one null, the others missing.
      fanPct: null,
    },
  ],
  allGpus: [],
  proc: { cpuPct: 50, rssBytes: 2048 },
  system: {
    cpuPct: 10,
    corePct: [10, 20],
    freqMhz: null,
    tempC: 45,
    load: [1, 0.5, 0.25],
    mem: null,
  },
  disk: null,
  points: { 'llama.genTps': 12.5, 'sys.cpu': null },
  history: { intervalMs: 1000, capacity: 300 },
};

const Json = Schema.fromJsonString(Snapshot);

test('a snapshot round-trips through JSON', async () => {
  const back = await Effect.runPromise(
    Schema.encodeUnknownEffect(Json)(snapshot).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Json))),
  );
  expect(back).toStrictEqual(snapshot);
});

test('a snapshot with NaN does not encode', async () => {
  const exit = await Effect.runPromiseExit(
    Schema.encodeUnknownEffect(Json)({ ...snapshot, rates: { genTps: Number.NaN, ppTps: 0 } }),
  );
  expect(Exit.isFailure(exit)).toBe(true);
});

test('a snapshot with a fractional busySlots encodes', async () => {
  // `llamacpp:n_busy_slots_per_decode` is an average per llama_decode() call: 1.5 when the occupancy varies.
  const fractional = { ...snapshot, queue: { processing: 2, deferred: 0, busySlots: 1.5 } };
  const exit = await Effect.runPromiseExit(Schema.encodeUnknownEffect(Json)(fractional));
  expect(Exit.isSuccess(exit)).toBe(true);
});

test('WsMessage takes a snapshot and a null placement', async () => {
  const decode = Schema.decodeUnknownEffect(WsMessage);
  expect(await Effect.runPromise(decode({ type: 'placement', payload: null }))).toStrictEqual({
    type: 'placement',
    payload: null,
  });
  expect(await Effect.runPromise(decode({ type: 'snapshot', payload: snapshot }))).toStrictEqual({
    type: 'snapshot',
    payload: snapshot,
  });
});
