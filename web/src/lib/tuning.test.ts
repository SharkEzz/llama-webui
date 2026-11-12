import type { BenchDevice } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { otSuggestions, replacedProfileParams } from './tuning';

const dev = (id: string, name: string, totalMib: number): BenchDevice => ({
  id,
  name,
  totalMib,
  freeMib: totalMib,
  backend: id.replace(/\d+$/, ''),
});

test('-ot suggestions name the dedicated cards of this machine, not a hard-coded device (#23)', () => {
  const devices = [
    dev('CUDA0', 'NVIDIA GeForce RTX 4090', 24000),
    dev('ROCm0', 'AMD Radeon Graphics', 30000),
    dev('Vulkan0', 'NVIDIA GeForce RTX 4090', 24500),
  ];
  const s = otSuggestions(devices);
  expect(s).toContain('exps=CPU');
  expect(s).toContain('ffn_.*_exps=CUDA0');
  expect(s.some((x) => x.includes('Vulkan3'))).toBe(false);
  // Neither the iGPU nor the Vulkan copy of the CUDA card.
  expect(s.filter((x) => !x.endsWith('=CPU'))).toEqual(['ffn_.*_exps=CUDA0']);
});

test('the profile flags replaced by the recommendation leave out those pinned to the same value', () => {
  const profile = { ngl: 'all' as const, dev: ['CUDA0', 'CUDA1'], ctk: 'f8_e4m3' as const, ctv: 'f8_e4m3' as const };
  expect(replacedProfileParams(profile, {})).toEqual(profile);
  expect(replacedProfileParams(profile, { ctk: 'f8_e4m3', ctv: 'f8_e4m3', dev: ['CUDA0'] })).toEqual({
    ngl: 'all',
    dev: ['CUDA0', 'CUDA1'],
  });
  expect(replacedProfileParams(profile, profile)).toEqual({});
});
