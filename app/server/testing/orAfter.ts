import { setTimeout as sleep } from 'node:timers/promises';

/**
 * `p`, or `late` once `ms` have passed. The timer is cancelled either way: a bare
 * `Promise.race([p, sleep(ms)])` leaves the timer's promise pending when `p` wins, which Vitest reports as an async
 * leak whenever the test file ends before the timer does.
 */
export async function orAfter<T, const L>(p: Promise<T>, ms: number, late: L): Promise<T | L> {
  const timer = new AbortController();
  try {
    return await Promise.race([p, sleep(ms, late, { ref: false, signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}
