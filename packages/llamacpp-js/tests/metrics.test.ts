import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchLlama } from '../src/client.ts';
import {
  foldRecent,
  kvUsage,
  type LlamaRaw,
  lastRequestStats,
  liveRates,
  mergeRequestStats,
  parsePrometheus,
  parseSlots,
  type RequestRecord,
  requestDelta,
  type SlotView,
  specStats,
} from '../src/metrics.ts';
import { closeTo, fixture, matchObject } from './helpers.ts';

const after = parsePrometheus(await fixture('metrics-after.txt'));
const idle = parsePrometheus(await fixture('metrics-idle.txt'));

describe('parsePrometheus', () => {
  test('reads plain and labelled series', () => {
    assert.equal(after.get('llamacpp:tokens_predicted_total'), 300);
    assert.equal(after.get('llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"}'), 87);
    assert.equal(after.has('# HELP'), false);
  });
  test('skips garbage', () => {
    const m = parsePrometheus('a 1\nb notanumber\n\n# c\nd 2.5');
    assert.deepEqual(
      [...m.entries()],
      [
        ['a', 1],
        ['d', 2.5],
      ],
    );
  });
});

describe('parseSlots', () => {
  test('busy slot', async () => {
    assert.deepEqual(parseSlots(JSON.parse(await fixture('slots-busy.json')))[0], {
      id: 0,
      nCtx: 40192,
      processing: true,
      idTask: 2,
      nPromptTokens: 92,
      nPromptProcessed: 68,
      nDecoded: 21,
      nRemain: 279,
    });
  });
  test('idle slot', async () => {
    const s = parseSlots(JSON.parse(await fixture('slots-idle.json')))[0]!;
    assert.equal(s.processing, false);
    assert.equal(s.nDecoded, 0);
    assert.equal(s.idTask, null);
  });
  test('garbage', () => {
    assert.deepEqual(parseSlots({}), []);
    assert.deepEqual(parseSlots([null, 3]), []);
  });
  test('next_token as object', () => {
    assert.equal(parseSlots([{ id: 1, is_processing: true, next_token: { n_decoded: 4 } }])[0]!.nDecoded, 4);
  });
});

const slot = (o: Partial<SlotView>): SlotView => ({
  id: 0,
  nCtx: 100,
  processing: true,
  idTask: 2,
  nPromptTokens: 0,
  nPromptProcessed: 0,
  nDecoded: 0,
  nRemain: null,
  ...o,
});
const raw = (at: number, slots: SlotView[]): LlamaRaw => ({ at, health: 'ok', slots, metrics: null });

describe('liveRates', () => {
  test('same task delta', () => {
    assert.equal(liveRates(raw(0, [slot({ nDecoded: 21 })]), raw(1000, [slot({ nDecoded: 26 })])).genTps, 5);
  });
  test('task changed → current value', () => {
    assert.equal(liveRates(raw(0, [slot({ nDecoded: 21 })]), raw(1000, [slot({ idTask: 3, nDecoded: 4 })])).genTps, 4);
  });
  test('prompt processing rate', () => {
    const r = liveRates(raw(0, [slot({ nPromptProcessed: 10 })]), raw(500, [slot({ nPromptProcessed: 30 })]));
    assert.equal(r.ppTps, 40);
  });
  test('no prev or idle → 0', () => {
    assert.deepEqual(liveRates(null, raw(1000, [slot({ nDecoded: 5 })])), { genTps: 0, ppTps: 0 });
    assert.deepEqual(liveRates(raw(0, [slot({})]), raw(1000, [slot({ processing: false, nDecoded: 9 })])), {
      genTps: 0,
      ppTps: 0,
    });
  });
});

describe('lastRequestStats', () => {
  test('computes per-request rates from counter deltas', () => {
    const s = lastRequestStats(idle, after)!;
    closeTo(s.genTps!, 300 / 56.0309, 2);
    closeTo(s.ppTps!, 68 / 2.44401, 2);
    closeTo(s.specAccept!, 174 / 374, 4);
  });
  test('unchanged → null', () => assert.equal(lastRequestStats(after, after), null));
});

test('specStats', () => {
  const s = specStats(after);
  closeTo(s.acceptCum!, 0.4652, 3);
  assert.equal(s.drafts, 125);
  assert.equal(s.draftTokens, 374);
  assert.equal(s.accepted, 174);
  closeTo(s.meanAcceptedPerDraft!, 1.392, 3);
  assert.equal(s.perPos.length, 3);
  closeTo(s.perPos[0]!, 0.696, 3);
  closeTo(s.perPos[1]!, 0.44, 3);
  closeTo(s.perPos[2]!, 0.256, 3);
  assert.equal(specStats(idle).acceptCum, null);
});

describe('fetchLlama', () => {
  test('503 → loading, no slots', async () => {
    const f = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const r = await fetchLlama('http://x', f);
    assert.equal(r.health, 'loading');
    assert.equal(r.slots, null);
  });
  test('ok → slots and metrics', async () => {
    const body = {
      '/health': '{"status":"ok"}',
      '/slots': await fixture('slots-busy.json'),
      '/metrics': await fixture('metrics-after.txt'),
    };
    const f = (async (u: string) =>
      new Response(body[new URL(u).pathname as keyof typeof body])) as unknown as typeof fetch;
    const r = await fetchLlama('http://x', f);
    assert.equal(r.health, 'ok');
    assert.equal(r.slots?.[0]?.nDecoded, 21);
    assert.equal(r.metrics?.get('llamacpp:tokens_predicted_total'), 300);
  });
  test('hung server → down within timeout', async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new Error('abort'))),
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await fetchLlama('http://x', f, 50);
    assert.equal(r.health, 'down');
    assert.ok(Date.now() - t0 < 200);
  });
  test('network error → down', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    assert.equal((await fetchLlama('http://x', f)).health, 'down');
  });
});

describe('mergeRequestStats (prompt and generation counters land on different ticks)', () => {
  test('generation delta keeps the prompt rate of the same request', () => {
    const afterPrompt = mergeRequestStats(null, { genTps: null, ppTps: 124.6, specAccept: null });
    const afterGen = mergeRequestStats(afterPrompt, { genTps: 44.7, ppTps: null, specAccept: 0.415 });
    assert.deepEqual(afterGen, { genTps: 44.7, ppTps: 124.6, specAccept: 0.415 });
  });
  test('a new prompt starts a new request', () => {
    const prev = { genTps: 44.7, ppTps: 124.6, specAccept: 0.415 };
    assert.deepEqual(mergeRequestStats(prev, { genTps: null, ppTps: 90, specAccept: null }), {
      genTps: null,
      ppTps: 90,
      specAccept: null,
    });
  });
  test('both in one delta', () => {
    const d = { genTps: 5, ppTps: 27.8, specAccept: 0.8 };
    assert.deepEqual(mergeRequestStats({ genTps: 1, ppTps: 1, specAccept: 1 }, d), d);
  });
  test('null delta keeps previous', () => {
    const prev = { genTps: 1, ppTps: 2, specAccept: 0.5 };
    assert.equal(mergeRequestStats(prev, null), prev);
  });
});

describe('context usage and recent requests', () => {
  const slot = (p: number, d: number, ctx: number): SlotView => ({
    id: 0,
    nCtx: ctx,
    processing: true,
    idTask: 1,
    nPromptTokens: p,
    nPromptProcessed: p,
    nDecoded: d,
    nRemain: null,
  });

  test('kvUsage sums slots; generated tokens are already in n_prompt_tokens', () => {
    // Real slot mid-generation: a 29-token prompt, 1110 generated, n_prompt_tokens 1142.
    assert.deepEqual(kvUsage([slot(1142, 1110, 64512), slot(0, 0, 64512)]), { usedTokens: 1142, totalTokens: 129024 });
    assert.equal(kvUsage([]), null);
    assert.equal(kvUsage(null), null);
    assert.equal(kvUsage([slot(0, 0, 0)]), null);
  });

  const metricsMap = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [`llamacpp:${k}`, v]));

  test('requestDelta', () => {
    const prev = metricsMap({
      prompt_tokens_total: 0,
      prompt_tokens_cached_total: 0,
      prompt_seconds_total: 0,
      tokens_predicted_total: 0,
      tokens_predicted_seconds_total: 0,
    });
    const cur = metricsMap({
      prompt_tokens_total: 68,
      prompt_tokens_cached_total: 20,
      prompt_seconds_total: 2,
      tokens_predicted_total: 0,
      tokens_predicted_seconds_total: 0,
    });
    assert.deepEqual(requestDelta(prev, cur, 5), {
      at: 5,
      promptTokens: 68,
      cachedTokens: 20,
      genTokens: 0,
      promptSec: 2,
      genSec: null,
      ppTps: 34,
      genTps: null,
      specAccept: null,
    });
    assert.equal(requestDelta(cur, cur, 6), null);
    const gen = metricsMap({
      prompt_tokens_total: 68,
      prompt_seconds_total: 2,
      tokens_predicted_total: 300,
      tokens_predicted_seconds_total: 60,
      spec_decode_num_draft_tokens_total: 10,
      spec_decode_num_accepted_tokens_total: 5,
    });
    matchObject(requestDelta(cur, gen, 7), {
      promptTokens: 0,
      genTokens: 300,
      genSec: 60,
      genTps: 5,
      specAccept: 0.5,
    });
  });

  test('foldRecent starts on prompt deltas and completes on generation-only deltas', () => {
    const p: RequestRecord = {
      at: 1,
      promptTokens: 68,
      cachedTokens: 0,
      genTokens: 0,
      promptSec: 2,
      genSec: null,
      ppTps: 34,
      genTps: null,
      specAccept: null,
    };
    const g: RequestRecord = {
      at: 2,
      promptTokens: 0,
      cachedTokens: 0,
      genTokens: 300,
      promptSec: null,
      genSec: 60,
      ppTps: null,
      genTps: 5,
      specAccept: 0.5,
    };
    const l1 = foldRecent([], p);
    const l2 = foldRecent(l1, g);
    assert.deepEqual(l2, [{ ...p, genTokens: 300, genSec: 60, genTps: 5, specAccept: 0.5 }]);
    matchObject(foldRecent(l2, { ...g, genTokens: 100, genSec: 20, specAccept: null })[0], {
      genTokens: 400,
      genSec: 80,
      genTps: 5,
      specAccept: 0.5,
    });
    assert.deepEqual(
      foldRecent(l2, { ...p, at: 3 }).map((r) => r.at),
      [3, 1],
    );
    assert.deepEqual(foldRecent([], g), [g]);
    assert.equal(foldRecent(l2, null), l2);
    // Kept for wide dashboards, where Recent requests grows to fill its column.
    const many = Array.from({ length: 45 }, (_, i) => ({ ...p, at: i })).reduce<RequestRecord[]>(
      (l, r) => foldRecent(l, r),
      [],
    );
    assert.equal(many.length, 40);
    assert.equal(many[0]!.at, 44);
  });
});
