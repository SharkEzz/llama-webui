import { describe, expect, test } from 'vitest';
import { clock, createSimulation, HISTORY_SECONDS, MAX_REQUESTS, RUN } from './telemetry.ts';

describe('createSimulation', () => {
  test('is deterministic for a given seed (prerender and hydration match)', () => {
    const a = createSimulation(42);
    const b = createSimulation(42);
    expect(a.frame()).toEqual(b.frame());
    for (let i = 0; i < 30; i++) expect(a.tick()).toEqual(b.tick());
  });

  test('starts warm: full history and some finished requests', () => {
    const frame = createSimulation().frame();
    expect(frame.history).toHaveLength(HISTORY_SECONDS);
    expect(frame.requests.length).toBeGreaterThan(0);
    expect(frame.requests.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  test('history is one point per second, oldest first', () => {
    const sim = createSimulation();
    for (let i = 0; i < 10; i++) sim.tick();
    const { history, at } = sim.frame();
    expect(history.at(-1)!.at).toBe(at);
    history.forEach((p, i) => {
      if (i > 0) expect(p.at - history[i - 1]!.at).toBe(1);
    });
  });

  test('stays within measured bounds over a long run', () => {
    const sim = createSimulation(3);
    for (let i = 0; i < 600; i++) {
      const f = sim.tick();
      expect(f.genTps).toBeGreaterThanOrEqual(0);
      expect(f.genTps).toBeLessThan(90);
      expect(f.ppTps).toBeGreaterThanOrEqual(0);
      expect(f.ppTps).toBeLessThanOrEqual(1100);
      expect(f.acceptPct).toBeGreaterThan(30);
      expect(f.acceptPct).toBeLessThan(65);
      expect(f.ctxUsed).toBeLessThanOrEqual(RUN.ctxTotal);
      expect(f.cpuPct).toBeLessThanOrEqual(100);
      for (const g of f.gpus) {
        expect(g.utilPct).toBeGreaterThanOrEqual(0);
        expect(g.utilPct).toBeLessThanOrEqual(100);
      }
    }
  });

  test('alternates idle gaps and generations', () => {
    const sim = createSimulation(5);
    const phases = new Set<string>();
    let switches = 0;
    let last = sim.frame().phase;
    for (let i = 0; i < 120; i++) {
      const { phase } = sim.tick();
      phases.add(phase);
      if (phase !== last) switches++;
      last = phase;
    }
    expect(phases.has('idle')).toBe(true);
    expect(phases.has('generating')).toBe(true);
    expect(switches).toBeGreaterThan(6);
  });

  test('lists requests newest first with consistent durations', () => {
    const sim = createSimulation();
    for (let i = 0; i < 90; i++) sim.tick();
    const { requests } = sim.frame();
    requests.forEach((r, i) => {
      if (i > 0) expect(r.at).toBeLessThan(requests[i - 1]!.at);
      expect(r.durationSec).toBeCloseTo(r.prompt / r.ppTps + r.generated / r.genTps, 6);
    });
  });
});

test('clock formats seconds since midnight', () => {
  expect(clock(21 * 3600 + 58 * 60 + 7)).toBe('21:58:07');
  expect(clock(86_400 + 5)).toBe('00:00:05');
});
