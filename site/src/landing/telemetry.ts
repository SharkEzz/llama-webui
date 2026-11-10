/**
 * Simulated llama-webui telemetry for the hero's live dashboard.
 *
 * The figures replay a run measured on real hardware while preparing the website (demo instance, Nov 2026):
 * Qwen3.8 27B IQ3_S with MTP speculative decoding, split with `-sm layer` across an RTX 5070 Ti and an
 * RTX 5060 Ti: ~65–75 tok/s generation, 40–55 % draft acceptance, ~7.4 / 8.6 GiB VRAM, 7 GiB of 61 GiB RAM.
 *
 * Pure and deterministic (seeded): the prerendered HTML and the hydrated page start from the same frame, and the
 * simulation is pre-warmed so the throughput chart is already full on first paint. One `tick()` = one second, like
 * the app's default polling interval.
 */

export type Phase = 'idle' | 'prompt' | 'generating';

export interface GpuSample {
  name: string;
  utilPct: number;
  vramUsedGiB: number;
  vramTotalGiB: number;
}

export interface HistoryPoint {
  /** Seconds since midnight (simulated clock). */
  at: number;
  gen: number;
  pp: number;
  /** CPU load in percent, for the System card's history. */
  cpu: number;
}

export interface RequestRow {
  id: number;
  /** Start of the request, seconds since midnight. */
  at: number;
  prompt: number;
  cached: number;
  generated: number;
  durationSec: number;
  ppTps: number;
  genTps: number;
  acceptPct: number;
}

export interface Frame {
  at: number;
  phase: Phase;
  /** Rates over the last second, as the app's stat tiles show them. */
  genTps: number;
  ppTps: number;
  acceptPct: number;
  tokensPerDraft: number;
  ctxUsed: number;
  ctxTotal: number;
  cpuPct: number;
  ramUsedGiB: number;
  ramTotalGiB: number;
  gpus: GpuSample[];
  /** Oldest first, HISTORY_SECONDS points. */
  history: HistoryPoint[];
  /** Newest first, at most MAX_REQUESTS rows. */
  requests: RequestRow[];
}

export const HISTORY_SECONDS = 60;
export const MAX_REQUESTS = 4;
const WARMUP_SECONDS = 75;

export const RUN = {
  model: 'Qwen3.8 27B',
  profile: 'Qwen3.8 27B · chat (MTP)',
  ctxTotal: 32_768,
  ramTotalGiB: 61,
  ramUsedGiB: 7.1,
  /** 21:58:00, the time of the measured run. */
  startAt: 21 * 3600 + 58 * 60,
  gpus: [
    { name: 'RTX 5070 Ti', vramUsedGiB: 7.4, vramTotalGiB: 15.9, busyUtil: 90 },
    { name: 'RTX 5060 Ti', vramUsedGiB: 8.6, vramTotalGiB: 15.9, busyUtil: 95 },
  ],
} as const;

/**
 * A chat, replayed in a loop: each turn sends a short new prompt (the earlier turns are in the cache) and streams a
 * 5 to 17 s answer. Prompt tokens, generated tokens, prompt rate, generation rate, draft acceptance.
 */
const SCRIPT = [
  { prompt: 61, generated: 742, ppRate: 271, genRate: 68.4, accept: 0.47 },
  { prompt: 28, generated: 415, ppRate: 198, genRate: 71.2, accept: 0.52 },
  { prompt: 74, generated: 1120, ppRate: 390, genRate: 66.9, accept: 0.44 },
  { prompt: 45, generated: 638, ppRate: 288, genRate: 63.5, accept: 0.41 },
  { prompt: 27, generated: 356, ppRate: 191, genRate: 72.8, accept: 0.55 },
] as const;

interface Job {
  id: number;
  at: number;
  prompt: number;
  cached: number;
  generated: number;
  ppRate: number;
  genRate: number;
  accept: number;
  promptLeft: number;
  genLeft: number;
}

/** mulberry32: small, fast, good enough for jitter. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export interface Simulation {
  frame(): Frame;
  /** Advances the simulated clock by one second and returns the new frame. */
  tick(): Frame;
}

export function createSimulation(seed = 7, warmup = WARMUP_SECONDS): Simulation {
  const rand = random(seed);
  const jitter = (spread: number) => 1 + (rand() * 2 - 1) * spread;

  let at = RUN.startAt;
  let idleLeft = 1;
  let job: Job | null = null;
  let nextId = 1;
  let scriptIndex = 0;
  let ctxUsed = 0;
  let lastAccept: number = SCRIPT[0].accept;
  const history: HistoryPoint[] = [];
  const requests: RequestRow[] = [];
  let current: Frame;

  function startJob(): Job {
    const step = SCRIPT[scriptIndex % SCRIPT.length]!;
    // A new conversation every time the script loops: the context starts over.
    if (scriptIndex % SCRIPT.length === 0) ctxUsed = 0;
    scriptIndex++;
    return {
      id: nextId++,
      at,
      prompt: step.prompt,
      cached: ctxUsed,
      generated: step.generated,
      ppRate: step.ppRate * jitter(0.05),
      genRate: step.genRate * jitter(0.04),
      accept: clamp(step.accept * jitter(0.06), 0, 1),
      promptLeft: step.prompt,
      genLeft: step.generated,
    };
  }

  function finish(done: Job) {
    ctxUsed = Math.min(RUN.ctxTotal, ctxUsed + done.prompt + done.generated);
    lastAccept = done.accept;
    requests.unshift({
      id: done.id,
      at: done.at,
      prompt: done.prompt,
      cached: done.cached,
      generated: done.generated,
      durationSec: done.prompt / done.ppRate + done.generated / done.genRate,
      ppTps: done.ppRate,
      genTps: done.genRate,
      acceptPct: done.accept * 100,
    });
    requests.length = Math.min(requests.length, MAX_REQUESTS);
  }

  function step(): Frame {
    let budget = 1; // seconds left in this tick
    let pp = 0;
    let gen = 0;
    let busy = 0;

    while (budget > 1e-9) {
      if (!job) {
        if (idleLeft > 0) {
          const spent = Math.min(budget, idleLeft);
          idleLeft -= spent;
          budget -= spent;
          continue;
        }
        job = startJob();
      }
      if (job.promptLeft > 0) {
        const tokens = Math.min(job.promptLeft, job.ppRate * budget);
        job.promptLeft -= tokens;
        pp += tokens;
        const spent = tokens / job.ppRate;
        budget -= spent;
        busy += spent;
        continue;
      }
      // Generation speed wobbles from second to second, as the measured run did.
      const rate = job.genRate * jitter(0.09);
      const tokens = Math.min(job.genLeft, rate * budget);
      job.genLeft -= tokens;
      gen += tokens;
      const spent = tokens / rate;
      budget -= spent;
      busy += spent;
      if (job.genLeft <= 1e-9) {
        finish(job);
        job = null;
        idleLeft = 3 + rand() * 4; // the user reads, then types the next message
      }
    }

    at += 1;
    const cpuPct = Math.round(3 + busy * 11 + rand() * 2);
    history.push({ at, gen: round1(gen), pp: round1(pp), cpu: cpuPct });
    if (history.length > HISTORY_SECONDS) history.shift();

    const phase: Phase = !job ? 'idle' : job.promptLeft > 0 ? 'prompt' : 'generating';
    return {
      at,
      phase,
      genTps: round1(gen),
      ppTps: round1(pp),
      acceptPct: Math.round(lastAccept * 100),
      tokensPerDraft: round1(lastAccept * 2.9),
      ctxUsed: Math.min(RUN.ctxTotal, ctxUsed + (job ? job.prompt - job.promptLeft + job.generated - job.genLeft : 0)),
      ctxTotal: RUN.ctxTotal,
      cpuPct,
      ramUsedGiB: RUN.ramUsedGiB,
      ramTotalGiB: RUN.ramTotalGiB,
      gpus: RUN.gpus.map((g) => ({
        name: g.name,
        utilPct: Math.round(clamp(busy * g.busyUtil * jitter(0.03) + (1 - busy) * 2, 0, 100)),
        vramUsedGiB: g.vramUsedGiB,
        vramTotalGiB: g.vramTotalGiB,
      })),
      history: [...history],
      requests: requests.map((r) => ({ ...r })),
    };
  }

  current = step();
  for (let i = 1; i < warmup; i++) current = step();

  return {
    frame: () => current,
    tick: () => {
      current = step();
      return current;
    },
  };
}

/** "21:58:07" from seconds since midnight. */
export function clock(at: number): string {
  const s = ((at % 86_400) + 86_400) % 86_400;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}
