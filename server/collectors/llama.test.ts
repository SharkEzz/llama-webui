import { describe, expect, test } from "bun:test";
import { fetchLlama, type LlamaRaw, lastRequestStats, liveRates, parseSlots, type SlotView, specStats } from "./llama";
import { parsePrometheus } from "./prometheus";

const fx = (n: string) => Bun.file(`${import.meta.dir}/../../testdata/${n}`);
const after = parsePrometheus(await fx("metrics-after.txt").text());
const idle = parsePrometheus(await fx("metrics-idle.txt").text());

describe("parsePrometheus", () => {
  test("reads plain and labelled series", () => {
    expect(after.get("llamacpp:tokens_predicted_total")).toBe(300);
    expect(after.get('llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"}')).toBe(87);
    expect(after.has("# HELP")).toBe(false);
  });
  test("skips garbage", () => {
    const m = parsePrometheus("a 1\nb notanumber\n\n# c\nd 2.5");
    expect([...m.entries()]).toEqual([
      ["a", 1],
      ["d", 2.5],
    ]);
  });
});

describe("parseSlots", () => {
  test("busy slot", async () => {
    expect(parseSlots(await fx("slots-busy.json").json())[0]).toEqual({
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
  test("idle slot", async () => {
    const s = parseSlots(await fx("slots-idle.json").json())[0]!;
    expect(s.processing).toBe(false);
    expect(s.nDecoded).toBe(0);
    expect(s.idTask).toBeNull();
  });
  test("garbage", () => {
    expect(parseSlots({})).toEqual([]);
    expect(parseSlots([null, 3])).toEqual([]);
  });
  test("next_token as object", () => {
    expect(parseSlots([{ id: 1, is_processing: true, next_token: { n_decoded: 4 } }])[0]!.nDecoded).toBe(4);
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
const raw = (at: number, slots: SlotView[]): LlamaRaw => ({ at, health: "ok", slots, metrics: null });

describe("liveRates", () => {
  test("same task delta", () => {
    expect(liveRates(raw(0, [slot({ nDecoded: 21 })]), raw(1000, [slot({ nDecoded: 26 })])).genTps).toBe(5);
  });
  test("task changed → current value", () => {
    expect(liveRates(raw(0, [slot({ nDecoded: 21 })]), raw(1000, [slot({ idTask: 3, nDecoded: 4 })])).genTps).toBe(4);
  });
  test("prompt processing rate", () => {
    const r = liveRates(raw(0, [slot({ nPromptProcessed: 10 })]), raw(500, [slot({ nPromptProcessed: 30 })]));
    expect(r.ppTps).toBe(40);
  });
  test("no prev or idle → 0", () => {
    expect(liveRates(null, raw(1000, [slot({ nDecoded: 5 })]))).toEqual({ genTps: 0, ppTps: 0 });
    expect(liveRates(raw(0, [slot({})]), raw(1000, [slot({ processing: false, nDecoded: 9 })]))).toEqual({
      genTps: 0,
      ppTps: 0,
    });
  });
});

describe("lastRequestStats", () => {
  test("computes per-request rates from counter deltas", () => {
    const s = lastRequestStats(idle, after)!;
    expect(s.genTps!).toBeCloseTo(300 / 56.0309, 2);
    expect(s.ppTps!).toBeCloseTo(68 / 2.44401, 2);
    expect(s.specAccept!).toBeCloseTo(174 / 374, 4);
  });
  test("unchanged → null", () => expect(lastRequestStats(after, after)).toBeNull());
});

test("specStats", () => {
  const s = specStats(after);
  expect(s.acceptCum!).toBeCloseTo(0.4652, 3);
  expect(s.drafts).toBe(125);
  expect(s.draftTokens).toBe(374);
  expect(s.accepted).toBe(174);
  expect(s.meanAcceptedPerDraft!).toBeCloseTo(1.392, 3);
  expect(s.perPos.length).toBe(3);
  expect(s.perPos[0]!).toBeCloseTo(0.696, 3);
  expect(s.perPos[1]!).toBeCloseTo(0.44, 3);
  expect(s.perPos[2]!).toBeCloseTo(0.256, 3);
  expect(specStats(idle).acceptCum).toBeNull();
});

describe("fetchLlama", () => {
  test("503 → loading, no slots", async () => {
    const f = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = await fetchLlama("http://x", f);
    expect(r.health).toBe("loading");
    expect(r.slots).toBeNull();
  });
  test("ok → slots and metrics", async () => {
    const body = {
      "/health": '{"status":"ok"}',
      "/slots": await fx("slots-busy.json").text(),
      "/metrics": await fx("metrics-after.txt").text(),
    };
    const f = (async (u: string) =>
      new Response(body[new URL(u).pathname as keyof typeof body])) as unknown as typeof fetch;
    const r = await fetchLlama("http://x", f);
    expect(r.health).toBe("ok");
    expect(r.slots?.[0]?.nDecoded).toBe(21);
    expect(r.metrics?.get("llamacpp:tokens_predicted_total")).toBe(300);
  });
  test("hung server → down within timeout", async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("abort"))),
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await fetchLlama("http://x", f, 50);
    expect(r.health).toBe("down");
    expect(Date.now() - t0).toBeLessThan(200);
  });
  test("network error → down", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await fetchLlama("http://x", f)).health).toBe("down");
  });
});

import { mergeRequestStats } from "./llama";

describe("mergeRequestStats (prompt and generation counters land on different ticks)", () => {
  test("generation delta keeps the prompt rate of the same request", () => {
    const afterPrompt = mergeRequestStats(null, { genTps: null, ppTps: 124.6, specAccept: null });
    const afterGen = mergeRequestStats(afterPrompt, { genTps: 44.7, ppTps: null, specAccept: 0.415 });
    expect(afterGen).toEqual({ genTps: 44.7, ppTps: 124.6, specAccept: 0.415 });
  });
  test("a new prompt starts a new request", () => {
    const prev = { genTps: 44.7, ppTps: 124.6, specAccept: 0.415 };
    expect(mergeRequestStats(prev, { genTps: null, ppTps: 90, specAccept: null })).toEqual({
      genTps: null,
      ppTps: 90,
      specAccept: null,
    });
  });
  test("both in one delta", () => {
    const d = { genTps: 5, ppTps: 27.8, specAccept: 0.8 };
    expect(mergeRequestStats({ genTps: 1, ppTps: 1, specAccept: 1 }, d)).toEqual(d);
  });
  test("null delta keeps previous", () => {
    const prev = { genTps: 1, ppTps: 2, specAccept: 0.5 };
    expect(mergeRequestStats(prev, null)).toBe(prev);
  });
});

import { foldRecent, kvUsage, type RequestRecord, requestDelta } from "./llama";

describe("context usage and recent requests", () => {
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

  test("kvUsage sums slots", () => {
    expect(kvUsage([slot(100, 20, 1000), slot(0, 0, 1000)])).toEqual({ usedTokens: 120, totalTokens: 2000 });
    expect(kvUsage([])).toBeNull();
    expect(kvUsage(null)).toBeNull();
    expect(kvUsage([slot(0, 0, 0)])).toBeNull();
  });

  const metricsMap = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [`llamacpp:${k}`, v]));

  test("requestDelta", () => {
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
    expect(requestDelta(prev, cur, 5)).toEqual({
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
    expect(requestDelta(cur, cur, 6)).toBeNull();
    const gen = metricsMap({
      prompt_tokens_total: 68,
      prompt_seconds_total: 2,
      tokens_predicted_total: 300,
      tokens_predicted_seconds_total: 60,
      spec_decode_num_draft_tokens_total: 10,
      spec_decode_num_accepted_tokens_total: 5,
    });
    expect(requestDelta(cur, gen, 7)).toMatchObject({
      promptTokens: 0,
      genTokens: 300,
      genSec: 60,
      genTps: 5,
      specAccept: 0.5,
    });
  });

  test("foldRecent starts on prompt deltas and completes on generation-only deltas", () => {
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
    expect(l2).toEqual([{ ...p, genTokens: 300, genSec: 60, genTps: 5, specAccept: 0.5 }]);
    expect(foldRecent(l2, { ...g, genTokens: 100, genSec: 20, specAccept: null })[0]).toMatchObject({
      genTokens: 400,
      genSec: 80,
      genTps: 5,
      specAccept: 0.5,
    });
    expect(foldRecent(l2, { ...p, at: 3 }).map((r) => r.at)).toEqual([3, 1]);
    expect(foldRecent([], g)).toEqual([g]);
    expect(foldRecent(l2, null)).toBe(l2);
    // Kept for wide dashboards, where Requêtes récentes grows to fill its column.
    const many = Array.from({ length: 45 }, (_, i) => ({ ...p, at: i })).reduce<RequestRecord[]>(
      (l, r) => foldRecent(l, r),
      [],
    );
    expect(many.length).toBe(40);
    expect(many[0]!.at).toBe(44);
  });
});
