import { assert, describe, it } from '@effect/vitest';
import type { GpuSample } from '@llama-webui/shared';
import { Array as Arr } from 'effect';
import { gpuNeeds, gpuSkipped, identityReading, MEASURE_ALL, normalizeBusId, selectUsedGpus } from './gpu.ts';

const g = (key: string, busId: string, procVramBytes: number): GpuSample => ({
  key,
  vendor: 'nvidia',
  name: key,
  busId,
  utilPct: 0,
  vramUsedBytes: 0,
  vramTotalBytes: 0,
  tempC: null,
  powerW: null,
  procVramBytes,
});

describe('gpu helpers', () => {
  it('normalizeBusId', () => {
    assert.strictEqual(normalizeBusId('00000000:01:00.0'), '0000:01:00.0');
    assert.strictEqual(normalizeBusId('0000:0D:00.0'), '0000:0d:00.0');
    assert.strictEqual(normalizeBusId(' not a bus id '), 'not a bus id');
  });

  it('selectUsedGpus keeps the cards above 64 MiB, by bus id', () => {
    const used = selectUsedGpus([
      g('b', '0000:08:00.0', 6 * 1024 ** 3),
      g('i', '0000:0d:00.0', 32 * 1024),
      g('a', '0000:01:00.0', 5 * 1024 ** 3),
    ]);
    assert.deepStrictEqual(
      Arr.map(used, (x) => x.key),
      ['a', 'b'],
    );
  });

  it('gpuNeeds hides the cards of the setting, and identityReading lists one without readings', () => {
    const needs = gpuNeeds(['0000:01:00.0']);
    assert.isTrue(gpuSkipped(needs, '0000:01:00.0'));
    assert.isFalse(gpuSkipped(needs, '0000:02:00.0'));
    assert.isFalse(gpuSkipped(MEASURE_ALL, '0000:01:00.0'));
    assert.isTrue(gpuSkipped({ ...MEASURE_ALL, gpus: false }, '0000:02:00.0'));
    const r = identityReading({ key: 'k', vendor: 'amd', name: 'n', busId: 'b' }, 'hidden');
    assert.strictEqual(r.hidden, true);
    assert.strictEqual(r.vramTotalBytes, 0);
    assert.strictEqual(identityReading(r, 'suspended').suspended, true);
  });
});
