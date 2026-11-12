import { expect, test } from 'bun:test';
import { benchFailure } from './parse';

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../../testdata/llama-bench/${name}`).text();

test('benchFailure reports an out-of-memory load', async () => {
  const f = benchFailure((await fixture('oom-stderr.txt')).split('\n'), 1);
  expect(f.oom).toBe(true);
  expect(f.message.startsWith('Out of memory: ')).toBe(true);
  expect(f.message).toContain('unable to allocate CUDA1 buffer');
  expect(benchFailure(['nothing'], 2)).toEqual({ oom: false, message: 'llama-bench exited (code 2)' });
});
