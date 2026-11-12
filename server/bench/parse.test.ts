import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { benchFailure } from './parse';

const fixture = (name: string) => readFile(`${import.meta.dirname}/../../testdata/llama-bench/${name}`, 'utf8');

test('benchFailure reports an out-of-memory load', async () => {
  const f = benchFailure((await fixture('oom-stderr.txt')).split('\n'), 1);
  expect(f.oom).toBe(true);
  expect(f.message.startsWith('Out of memory: ')).toBe(true);
  expect(f.message).toContain('unable to allocate CUDA1 buffer');
  expect(benchFailure(['nothing'], 2)).toEqual({ oom: false, message: 'llama-bench exited (code 2)' });
});
