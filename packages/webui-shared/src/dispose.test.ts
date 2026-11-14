import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { defer } from './dispose.ts';

test('defer runs at the end of the block, after a return or a throw, in reverse order', () => {
  const calls: string[] = [];
  const ok = () => {
    using _a = defer(() => calls.push('a'));
    using _b = defer(() => calls.push('b'));
    calls.push('body');
    return 1;
  };
  expect(ok()).toBe(1);
  const boom = () => {
    using _c = defer(() => calls.push('c'));
    throw new Error('boom');
  };
  expect(boom).toThrow('boom');
  expect(calls).toEqual(['body', 'b', 'a', 'c']);
});

test('defer waits for the awaits of an async block', async () => {
  let busy = true;
  const run = async () => {
    using _busy = defer(() => (busy = false));
    await sleep(5);
    expect(busy).toBe(true);
  };
  await run();
  expect(busy).toBe(false);
});
