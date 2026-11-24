import { assert, describe, it } from '@effect/vitest';
import { type GpuSample, SERIES, Snapshot, type SystemSample } from '@llama-webui/shared';
import { Array as Arr, Effect, Option, Order, Record as Rec, Schema } from 'effect';
import type { LlamaRaw, SlotView } from 'llamacpp-js/metrics';
import { History } from './History.ts';
import { beginTick, endTick, initialMemory, slotsPlan, type TickMemory, type TickReading } from './tick.ts';

const gpu = (over: Partial<GpuSample> = {}): GpuSample => ({
  key: 'nvidia:GPU-1',
  vendor: 'nvidia',
  name: 'RTX',
  busId: '0000:01:00.0',
  utilPct: 40,
  vramUsedBytes: 4 * 1024 ** 3,
  vramTotalBytes: 16 * 1024 ** 3,
  tempC: 50,
  powerW: 120,
  procVramBytes: 2 * 1024 ** 3,
  ...over,
});

const system = (over: Partial<SystemSample> = {}): SystemSample => ({
  cpuPct: 12,
  corePct: [10, 14],
  freqMhz: 3000,
  tempC: 45,
  load: [1, 1, 1],
  mem: { totalBytes: 100, availableBytes: 75, cachedBytes: 10, swapTotalBytes: 0, swapUsedBytes: 0 },
  ...over,
});

const slot = (over: Partial<SlotView> = {}): SlotView => ({
  id: 0,
  nCtx: 1000,
  processing: true,
  idTask: 1,
  nPromptTokens: 250,
  nPromptProcessed: 100,
  nDecoded: 10,
  nRemain: 90,
  ...over,
});

const metrics = (entries: Record<string, number>) =>
  new Map(Arr.map(Rec.toEntries(entries), ([k, v]) => [`llamacpp:${k}`, v] as const));

const raw = (over: Partial<LlamaRaw> = {}): LlamaRaw => ({
  at: 1000,
  health: 'ok',
  slots: [slot()],
  metrics: metrics({}),
  ...over,
});

/** An idle tick at `at`: no server, the system and disk collectors off, no GPU. */
const idle = (at: number, over: Partial<TickReading> = {}): TickReading => ({
  at,
  active: false,
  pid: null,
  noSlots: false,
  raw: null,
  allGpus: [],
  proc: null,
  dramBps: null,
  system: Option.none(),
  disk: Option.none(),
  memBw: null,
  ...over,
});

/** An active tick of llama-server `pid` at `at`. */
const active = (at: number, pid: number, over: Partial<TickReading> = {}): TickReading =>
  idle(at, { active: true, pid, raw: raw({ at }), proc: { cpuPct: 150, rssBytes: 1e9 }, ...over });

/** One whole tick: `beginTick`, then `endTick`. */
const run = (memory: TickMemory, history: History, reading: TickReading) =>
  endTick(beginTick(memory, reading.pid, reading.active), history, reading);

/** A series as `dump` gives it. */
const seriesOf = (history: History, key: string) => Effect.map(history.dump(), (dump) => dump.series[key] ?? []);

describe('tick', () => {
  it.effect('an idle tick pushes 0 for the rates and only the series a screen draws', () =>
    Effect.gen(function* () {
      const history = new History(10, 1000);
      history.tick(500);
      history.series(SERIES.genTps).push(12);
      const { snapshot, memory } = run(initialMemory, history, idle(1000));
      assert.strictEqual(snapshot.tick, 1);
      assert.strictEqual(memory.tickNo, 1);
      assert.strictEqual(snapshot.health, null);
      assert.deepStrictEqual(snapshot.rates, { genTps: 0, ppTps: 0 });
      assert.deepStrictEqual([snapshot.slots, snapshot.kv, snapshot.queue, snapshot.proc], [null, null, null, null]);
      assert.deepStrictEqual(snapshot.points, { [SERIES.genTps]: 0, [SERIES.ppTps]: 0 });
      const gen = yield* seriesOf(history, SERIES.genTps);
      assert.deepStrictEqual(gen, [12, 0]);
      assert.deepStrictEqual(snapshot.history, { intervalMs: 1000, capacity: 10 });
    }),
  );

  it('a new pid resets the counters', () => {
    const history = new History(10, 1000);
    const m0 = metrics({ prompt_tokens_total: 0, prompt_seconds_total: 0 });
    const m1 = metrics({ prompt_tokens_total: 100, prompt_seconds_total: 1 });
    const first = run(initialMemory, history, active(1000, 41, { raw: raw({ at: 1000, metrics: m0 }) }));
    const second = run(first.memory, history, active(2000, 41, { raw: raw({ at: 2000, metrics: m1 }) }));
    assert.strictEqual(second.snapshot.lastRequest?.ppTps, 100);
    assert.lengthOf(second.snapshot.recentRequests, 1);
    assert.strictEqual(second.memory.ticksForPid, 2);
    // Another process: no rate from the old one's reads, its requests forgotten.
    const busier = raw({ at: 3000, slots: [slot({ nPromptProcessed: 300 })], metrics: m1 });
    const third = run(second.memory, history, active(3000, 42, { raw: busier }));
    assert.deepStrictEqual(third.snapshot.rates, { genTps: 0, ppTps: 0 });
    assert.deepStrictEqual(third.snapshot.recentRequests, []);
    assert.strictEqual(third.snapshot.lastRequest, null);
    assert.strictEqual(third.memory.lastPid, 42);
    assert.strictEqual(third.memory.ticksForPid, 1);
    assert.strictEqual(third.memory.tickNo, 3);
    // Same process: the rate from the previous read.
    const later = raw({ at: 4000, slots: [slot({ nPromptProcessed: 500 })], metrics: m1 });
    const fourth = run(third.memory, history, active(4000, 42, { raw: later }));
    assert.deepStrictEqual(fourth.snapshot.rates, { genTps: 0, ppTps: 200 });
  });

  it.effect('a series starts at its first known value and an existing one not fed gets a gap', () =>
    Effect.gen(function* () {
      const history = new History(10, 1000);
      const on = (at: number, readBps: number | null) =>
        idle(at, { system: Option.some(system()), memBw: readBps === null ? null : { readBps, writeBps: 1 } });
      let memory = initialMemory;
      memory = run(memory, history, on(1000, null)).memory;
      assert.isFalse(history.has(SERIES.memRead));
      memory = run(memory, history, on(2000, 50)).memory;
      const third = run(memory, history, on(3000, null));
      assert.strictEqual(third.snapshot.points[SERIES.memRead], null);
      // The first tick of a series no tick feeds any more (the GPU went away) also gets a gap.
      history.series('gpu.gone.util').push(5);
      const fourth = run(third.memory, history, on(4000, 52));
      assert.strictEqual(fourth.snapshot.points['gpu.gone.util'], null);
      const read = yield* seriesOf(history, SERIES.memRead);
      assert.deepStrictEqual(read, [null, 50, null, 52]);
    }),
  );

  it('GPU util is a gap for a hidden or suspended card', () => {
    const history = new History(10, 1000);
    const hidden = gpu({ key: 'nvidia:h', busId: '0000:02:00.0', hidden: true, utilPct: null, vramTotalBytes: 0 });
    const asleep = gpu({ key: 'amd:s', vendor: 'amd', busId: '0000:03:00.0', suspended: true, utilPct: null });
    const { snapshot } = run(initialMemory, history, idle(1000, { allGpus: [gpu(), hidden, asleep] }));
    assert.strictEqual(snapshot.points[SERIES.gpuUtil('nvidia:GPU-1')], 40);
    assert.strictEqual(snapshot.points[SERIES.gpuUtil('nvidia:h')], null);
    assert.strictEqual(snapshot.points[SERIES.gpuUtil('amd:s')], null);
    assert.strictEqual(snapshot.points[SERIES.gpuVramPct('nvidia:GPU-1')], 25);
    assert.isFalse(history.has(SERIES.gpuVramPct('nvidia:h')));
    assert.lengthOf(snapshot.allGpus, 3);
    // Idle: no card is llama-server's.
    assert.deepStrictEqual(snapshot.gpus, []);
  });

  it('a collector turned off leaves gaps in its series', () => {
    const MACHINE = [SERIES.sysCpu, SERIES.sysMemPct, SERIES.memRead, SERIES.diskRead, SERIES.modelDiskRead];
    const history = new History(10, 1000);
    const disk = { readBps: 10, writeBps: 20, perDisk: {}, model: { disk: 'nvme0n1', readBps: 5 } };
    const on = idle(1000, {
      system: Option.some(system()),
      disk: Option.some(disk),
      memBw: { readBps: 1e9, writeBps: 2e9 },
    });
    const first = run(initialMemory, history, on);
    assert.deepStrictEqual(
      Arr.map(MACHINE, (k) => first.snapshot.points[k]),
      [12, 25, 1e9, 10, 5],
    );
    assert.deepStrictEqual(first.snapshot.system?.memBw, { readBps: 1e9, writeBps: 2e9 });
    const off = run(first.memory, history, idle(2000));
    assert.deepStrictEqual(
      Arr.map(MACHINE, (k) => off.snapshot.points[k]),
      [null, null, null, null, null],
    );
    assert.deepStrictEqual([off.snapshot.system, off.snapshot.disk], [null, null]);
    // A collector on whose read failed: 0, not a gap.
    const failed = run(off.memory, history, idle(3000, { system: Option.some(null), disk: Option.some(null) }));
    assert.deepStrictEqual(
      Arr.map([SERIES.sysCpu, SERIES.diskRead], (k) => failed.snapshot.points[k]),
      [0, 0],
    );
  });

  it("points carry this tick's values with NaN as null", () => {
    const history = new History(10, 1000);
    const busy = raw({
      at: 1000,
      slots: [slot({ nPromptTokens: 250, nCtx: 1000 })],
      metrics: metrics({ requests_processing: 1, requests_deferred: 2, n_busy_slots_per_decode: 0.5 }),
    });
    const used = gpu({ utilPct: Number.NaN });
    const { snapshot } = run(
      initialMemory,
      history,
      active(1000, 7, { raw: busy, allGpus: [used, gpu({ key: 'nvidia:idle', procVramBytes: 0 })], dramBps: 3e9 }),
    );
    assert.strictEqual(snapshot.health, 'ok');
    // The values no screen draws over time stay in the snapshot, out of the history.
    assert.deepStrictEqual(
      Arr.sort(Rec.keys(snapshot.points), Order.String),
      Arr.sort(
        [
          SERIES.genTps,
          SERIES.ppTps,
          SERIES.gpuUtil('nvidia:GPU-1'),
          SERIES.gpuUtil('nvidia:idle'),
          SERIES.gpuVramPct('nvidia:GPU-1'),
          SERIES.gpuVramPct('nvidia:idle'),
        ],
        Order.String,
      ),
    );
    assert.deepStrictEqual(snapshot.queue, { processing: 1, deferred: 2, busySlots: 0.5 });
    assert.deepStrictEqual(snapshot.kv, { usedTokens: 250, totalTokens: 1000 });
    assert.strictEqual(snapshot.points[SERIES.gpuUtil('nvidia:GPU-1')], null);
    assert.deepStrictEqual(snapshot.proc, { cpuPct: 150, rssBytes: 1e9, dramBps: 3e9 });
    // Only the card holding more than 64 MiB of llama-server's VRAM is one of its cards.
    assert.deepStrictEqual(
      Arr.map(snapshot.gpus, (g) => g.key),
      ['nvidia:GPU-1'],
    );
    // A server that does not answer is down.
    const down = run(initialMemory, new History(10, 1000), active(1000, 7, { raw: null }));
    assert.strictEqual(down.snapshot.health, 'down');
  });

  it('slotsPlan reads /slots only when the slots may have moved', () => {
    const quiet = metrics({ requests_processing: 0, requests_deferred: 0, n_decode_total: 128 });
    const idleSlot = slot({ processing: false });
    const known = (slots: LlamaRaw['slots'], before: ReadonlyMap<string, number> | null = quiet): TickMemory => ({
      ...initialMemory,
      prevRaw: raw({ slots }),
      prevMetrics: before,
    });
    const plan = (memory: TickMemory, now: ReadonlyMap<string, number> | null, noSlots = false) =>
      slotsPlan(memory, { noSlots, metrics: now });
    // Nothing moved since the last read: the known slots are kept, and llama-server may go to sleep.
    assert.strictEqual(plan(known([idleSlot]), quiet), 'keep');
    // A server whose /slots is off answers no slot: nothing to read again either.
    assert.strictEqual(plan(known([]), quiet), 'keep');
    // No slots known yet (the first tick, after a sleep, after a failed read).
    assert.strictEqual(plan(initialMemory, quiet), 'read');
    assert.strictEqual(plan(known(null), quiet), 'read');
    assert.strictEqual(plan(known([idleSlot], null), quiet), 'read');
    // A request running, or waiting for a slot.
    assert.strictEqual(plan(known([idleSlot]), metrics({ requests_processing: 1, n_decode_total: 128 })), 'read');
    assert.strictEqual(
      plan(known([idleSlot]), metrics({ requests_processing: 0, requests_deferred: 1, n_decode_total: 128 })),
      'read',
    );
    // The last read left a slot busy: read once more to see it end.
    assert.strictEqual(plan(known([slot({ processing: true })]), quiet), 'read');
    // A request that came and went between two ticks moved a counter.
    for (const key of ['prompt_tokens_total', 'tokens_predicted_total', 'n_decode_total']) {
      const moved = metrics({ requests_processing: 0, requests_deferred: 0, n_decode_total: 128, [key]: 500 });
      assert.strictEqual(plan(known([idleSlot]), moved), 'read');
    }
    // Without --metrics nothing tells: read on every tick.
    assert.strictEqual(plan(known([idleSlot], metrics({})), metrics({})), 'read');
    // Asleep, waking up or stopping, and when /metrics did not answer: no read, no slots.
    assert.strictEqual(plan(known([idleSlot]), quiet, true), 'skip');
    assert.strictEqual(plan(known([slot({ processing: true })]), metrics({ requests_processing: 1 }), true), 'skip');
    assert.strictEqual(plan(known([idleSlot]), null), 'skip');
    assert.strictEqual(slotsPlan({ noSlots: false, metrics: quiet })(known([idleSlot])), 'keep');
  });

  it('a tick that leaves /slots unread keeps the known slots; a barred or failed read has none', () => {
    const history = new History(10, 1000);
    const quiet = metrics({ requests_processing: 0, requests_deferred: 0, n_decode_total: 128 });
    const idleSlot = slot({ processing: false, nPromptTokens: 250, nCtx: 1000 });
    const first = run(
      initialMemory,
      history,
      active(1000, 5, { raw: raw({ at: 1000, slots: [idleSlot], metrics: quiet }) }),
    );
    // The monitor read no slots (the plan was `keep`): the snapshot still has them, and the context they hold.
    const kept = run(first.memory, history, active(2000, 5, { raw: raw({ at: 2000, slots: null, metrics: quiet }) }));
    assert.deepStrictEqual(kept.snapshot.slots, first.snapshot.slots);
    assert.deepStrictEqual(kept.snapshot.kv, { usedTokens: 250, totalTokens: 1000 });
    assert.deepStrictEqual(kept.snapshot.rates, { genTps: 0, ppTps: 0 });
    // A request starts: the read slots replace the kept ones, the rate is over one tick.
    const busy = metrics({ requests_processing: 1, requests_deferred: 0, n_decode_total: 140 });
    const reading = raw({ at: 3000, slots: [slot({ idTask: 2, nDecoded: 30, nPromptProcessed: 0 })], metrics: busy });
    const third = run(kept.memory, history, active(3000, 5, { raw: reading }));
    assert.deepStrictEqual(third.snapshot.rates, { genTps: 30, ppTps: 0 });
    // A read that was due and failed gives no slots, as before.
    const failed = run(third.memory, history, active(4000, 5, { raw: raw({ at: 4000, slots: null, metrics: busy }) }));
    assert.deepStrictEqual([failed.snapshot.slots, failed.snapshot.kv], [null, null]);
    // Asleep: no slots, whatever was known; nor when /metrics did not answer or the server is not `ok`.
    const asleep = run(
      kept.memory,
      history,
      active(5000, 5, { noSlots: true, raw: raw({ at: 5000, slots: null, metrics: quiet }) }),
    );
    assert.deepStrictEqual([asleep.snapshot.slots, asleep.snapshot.kv], [null, null]);
    const silent = run(kept.memory, history, active(5000, 5, { raw: raw({ at: 5000, slots: null, metrics: null }) }));
    assert.isNull(silent.snapshot.slots);
    const loading = run(
      kept.memory,
      history,
      active(5000, 5, { raw: raw({ at: 5000, health: 'loading', slots: null, metrics: null }) }),
    );
    assert.isNull(loading.snapshot.slots);
    // Once awake again, no slots are known: the next tick reads them.
    assert.strictEqual(slotsPlan(asleep.memory, { noSlots: false, metrics: quiet }), 'read');
  });

  it.effect('a tick fed non-finite readings still encodes as a Snapshot', () =>
    Effect.gen(function* () {
      const history = new History(10, 1000);
      const broken = raw({
        at: 2000,
        slots: [slot({ nCtx: Number.NaN, nPromptTokens: Number.POSITIVE_INFINITY, nDecoded: 2.5 })],
        metrics: metrics({
          requests_processing: Number.NaN,
          n_busy_slots_per_decode: Number.POSITIVE_INFINITY,
          prompt_tokens_total: 100,
          prompt_seconds_total: 0,
          tokens_predicted_total: 10,
          tokens_predicted_seconds_total: 1,
          spec_decode_num_draft_tokens_total: Number.POSITIVE_INFINITY,
        }),
      });
      const first = run(initialMemory, history, active(1000, 9, { raw: raw({ at: 1000, metrics: metrics({}) }) }));
      const { snapshot } = run(
        first.memory,
        history,
        active(2000, 9, {
          raw: broken,
          allGpus: [
            gpu({
              utilPct: Number.NaN,
              vramTotalBytes: 0,
              powerW: Number.POSITIVE_INFINITY,
              pcieRxBps: Number.POSITIVE_INFINITY,
              procVramBytes: Number.NaN,
            }),
          ],
          proc: { cpuPct: Number.POSITIVE_INFINITY, rssBytes: Number.NaN },
          dramBps: Number.NaN,
          system: Option.some(system({ cpuPct: Number.NaN, corePct: [Number.NEGATIVE_INFINITY] })),
          disk: Option.some({
            readBps: Number.POSITIVE_INFINITY,
            writeBps: 0,
            perDisk: { sda: { readBps: Number.NaN, writeBps: 1 } },
            model: null,
          }),
          memBw: { readBps: Number.POSITIVE_INFINITY, writeBps: Number.NaN },
        }),
      );
      const encoded = yield* Schema.encodeUnknownEffect(Snapshot)(snapshot);
      assert.strictEqual(encoded.allGpus[0]?.utilPct, null);
      assert.strictEqual(encoded.allGpus[0]?.pcieRxBps, null);
      assert.strictEqual(encoded.points[SERIES.gpuVramPct('nvidia:GPU-1')], undefined);
      assert.strictEqual(encoded.points[SERIES.memRead], undefined);
      assert.strictEqual(encoded.system?.cpuPct, 0);
      assert.deepStrictEqual(encoded.slots?.[0]?.nDecoded, 2);
    }),
  );
});
