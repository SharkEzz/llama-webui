import { expect, test } from 'bun:test';
import type { Profile } from '@llama-webui/shared';
import { commandChanged } from './draft';

const base: Profile = {
  id: 1,
  name: 'Qwen',
  model: 'qwen.gguf',
  args: ['-c', '8192'],
  env: {},
  source: 'ui',
  createdAt: 0,
  updatedAt: 0,
};

test('commandChanged ignores a rename and the timestamps, not the command fields', () => {
  expect(commandChanged(base, { ...base, name: 'Qwen 2', updatedAt: 5 })).toBe(false);
  expect(commandChanged(base, { ...base, args: ['-c', '16384'] })).toBe(true);
  expect(commandChanged(base, { ...base, port: 8081 })).toBe(true);
  expect(commandChanged(base, { ...base, env: { CUDA_VISIBLE_DEVICES: '0' } })).toBe(true);
  expect(commandChanged(base, { ...base, mmproj: 'mmproj.gguf' })).toBe(true);
});
