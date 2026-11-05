import { parsePrometheus } from "./prometheus";
import type { SlotView, Health, RequestStats, SpecStats, RequestRecord } from "@llama-webui/shared";
export type { SlotView, Health, RequestStats, SpecStats, RequestRecord };

export interface LlamaRaw {
  at: number;
  health: Health;
  slots: SlotView[] | null;
  metrics: Map<string, number> | null;
}

const P = "llamacpp:";
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseSlots(json: unknown): SlotView[] {
  if (!Array.isArray(json)) return [];
  const out: SlotView[] = [];
  for (const s of json) {
    if (typeof s !== "object" || s === null) continue;
    const o = s as Record<string, unknown>;
    const nt = Array.isArray(o.next_token) ? o.next_token[0] : o.next_token;
    const next = (typeof nt === "object" && nt !== null ? nt : {}) as Record<string, unknown>;
    out.push({
      id: num(o.id),
      nCtx: num(o.n_ctx),
      processing: o.is_processing === true,
      idTask: numOrNull(o.id_task),
      nPromptTokens: num(o.n_prompt_tokens),
      nPromptProcessed: num(o.n_prompt_tokens_processed),
      nDecoded: num(next.n_decoded),
      nRemain: numOrNull(next.n_remain),
    });
  }
  return out;
}

async function get(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export async function fetchLlama(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 800): Promise<LlamaRaw> {
  const at = Date.now();
  let health: Health;
  try {
    const r = await get(`${baseUrl}/health`, fetchImpl, timeoutMs);
    health = r.status === 200 ? "ok" : r.status === 503 ? "loading" : "error";
    await r.body?.cancel().catch(() => {});
  } catch {
    return { at, health: "down", slots: null, metrics: null };
  }
  if (health !== "ok") return { at, health, slots: null, metrics: null };
  const [slots, metrics] = await Promise.all([
    get(`${baseUrl}/slots`, fetchImpl, timeoutMs)
      .then((r) => r.json())
      .then(parseSlots)
      .catch(() => null),
    get(`${baseUrl}/metrics`, fetchImpl, timeoutMs)
      .then((r) => r.text())
      .then(parsePrometheus)
      .catch(() => null),
  ]);
  return { at, health, slots, metrics };
}

export function liveRates(prev: LlamaRaw | null, cur: LlamaRaw): { genTps: number; ppTps: number } {
  if (!prev?.slots || !cur.slots) return { genTps: 0, ppTps: 0 };
  const dt = (cur.at - prev.at) / 1000;
  if (dt <= 0) return { genTps: 0, ppTps: 0 };
  let gen = 0;
  let pp = 0;
  for (const s of cur.slots) {
    if (!s.processing) continue;
    const p = prev.slots.find((x) => x.id === s.id);
    const same = p?.processing && p.idTask === s.idTask;
    const d = (c: number, o: number | undefined) => (same && o !== undefined && c >= o ? c - o : c);
    gen += d(s.nDecoded, p?.nDecoded);
    pp += d(s.nPromptProcessed, p?.nPromptProcessed);
  }
  return { genTps: Math.max(0, gen / dt), ppTps: Math.max(0, pp / dt) };
}

const m0 = (m: Map<string, number>, k: string) => m.get(P + k) ?? 0;

export function lastRequestStats(prev: Map<string, number>, cur: Map<string, number>): RequestStats | null {
  const dPred = m0(cur, "tokens_predicted_total") - m0(prev, "tokens_predicted_total");
  const dPrompt = m0(cur, "prompt_tokens_total") - m0(prev, "prompt_tokens_total");
  if (dPred === 0 && dPrompt === 0) return null;
  const dPredS = m0(cur, "tokens_predicted_seconds_total") - m0(prev, "tokens_predicted_seconds_total");
  const dPromptS = m0(cur, "prompt_seconds_total") - m0(prev, "prompt_seconds_total");
  const dDraft = m0(cur, "spec_decode_num_draft_tokens_total") - m0(prev, "spec_decode_num_draft_tokens_total");
  const dAcc = m0(cur, "spec_decode_num_accepted_tokens_total") - m0(prev, "spec_decode_num_accepted_tokens_total");
  return {
    genTps: dPred > 0 && dPredS > 0 ? dPred / dPredS : null,
    ppTps: dPrompt > 0 && dPromptS > 0 ? dPrompt / dPromptS : null,
    specAccept: dDraft > 0 ? dAcc / dDraft : null,
  };
}

/** Context occupancy across slots (this llama.cpp build has no kv_cache_* metrics). */
export function kvUsage(slots: SlotView[] | null): { usedTokens: number; totalTokens: number } | null {
  if (!slots || slots.length === 0) return null;
  let usedTokens = 0;
  let totalTokens = 0;
  for (const s of slots) {
    usedTokens += s.nPromptTokens + s.nDecoded;
    totalTokens += s.nCtx;
  }
  return totalTokens > 0 ? { usedTokens, totalTokens } : null;
}

/**
 * One tick's worth of /metrics counter deltas. With several busy slots it aggregates their
 * requests: like lastRequest, the recent-request list is a per-tick approximation.
 */
export function requestDelta(prev: Map<string, number>, cur: Map<string, number>, at: number): RequestRecord | null {
  const d = (k: string) => m0(cur, k) - m0(prev, k);
  const promptTokens = d("prompt_tokens_total");
  const genTokens = d("tokens_predicted_total");
  if (promptTokens <= 0 && genTokens <= 0) return null;
  const pS = d("prompt_seconds_total");
  const gS = d("tokens_predicted_seconds_total");
  const promptSec = pS > 0 ? pS : null;
  const genSec = gS > 0 ? gS : null;
  const drafted = d("spec_decode_num_draft_tokens_total");
  return {
    at,
    promptTokens: Math.max(0, promptTokens),
    cachedTokens: Math.max(0, d("prompt_tokens_cached_total")),
    genTokens: Math.max(0, genTokens),
    promptSec,
    genSec,
    ppTps: promptTokens > 0 && promptSec ? promptTokens / promptSec : null,
    genTps: genTokens > 0 && genSec ? genTokens / genSec : null,
    specAccept: drafted > 0 ? d("spec_decode_num_accepted_tokens_total") / drafted : null,
  };
}

/** Newest first. Same split as mergeRequestStats: a prompt delta opens a request, a generation-only delta completes it. */
export function foldRecent(list: RequestRecord[], d: RequestRecord | null, max = 40): RequestRecord[] {
  if (!d) return list;
  if (d.promptTokens > 0 || list.length === 0) return [d, ...list].slice(0, max);
  const head = list[0]!;
  const genTokens = head.genTokens + d.genTokens;
  const genSec = head.genSec === null && d.genSec === null ? null : (head.genSec ?? 0) + (d.genSec ?? 0);
  return [
    {
      ...head,
      genTokens,
      genSec,
      genTps: genTokens > 0 && genSec ? genTokens / genSec : null,
      specAccept: d.specAccept ?? head.specAccept,
    },
    ...list.slice(1),
  ];
}

const POS_RE = /^llamacpp:spec_decode_num_accepted_tokens_per_pos_total\{position="(\d+)"\}$/;

/**
 * llama-server publishes prompt counters when the prompt finishes and generation counters when
 * the request finishes, so one request can show up as two deltas on different ticks.
 * A delta carrying a prompt rate starts a new request; a generation-only delta completes the current one.
 */
export function mergeRequestStats(prev: RequestStats | null, delta: RequestStats | null): RequestStats | null {
  if (!delta) return prev;
  if (delta.ppTps !== null || !prev) return delta;
  return { ...prev, genTps: delta.genTps ?? prev.genTps, specAccept: delta.specAccept ?? prev.specAccept };
}

export function specStats(m: Map<string, number>): SpecStats {
  const drafts = m0(m, "spec_decode_num_drafts_total");
  const draftTokens = m0(m, "spec_decode_num_draft_tokens_total");
  const accepted = m0(m, "spec_decode_num_accepted_tokens_total");
  const perPos: number[] = [];
  for (const [k, v] of m) {
    const match = POS_RE.exec(k);
    if (match) perPos[Number(match[1])] = drafts > 0 ? v / drafts : 0;
  }
  return {
    acceptCum: draftTokens > 0 ? accepted / draftTokens : null,
    drafts,
    draftTokens,
    accepted,
    meanAcceptedPerDraft: drafts > 0 ? accepted / drafts : null,
    perPos: Array.from(perPos, (v) => v ?? 0),
  };
}
