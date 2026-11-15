import { assert, describe, it } from '@effect/vitest';
import { Option } from 'effect';
import { parseSmiLine } from './vram.ts';

describe('vram', () => {
  it('parseSmiLine reads nvidia-smi loop lines as monitor keys', () => {
    assert.deepStrictEqual(
      parseSmiLine('GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, 47'),
      Option.some({ key: 'nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28', bytes: 47 * 1024 * 1024 }),
    );
    assert.deepStrictEqual(parseSmiLine('GPU-x, [N/A]'), Option.none());
    assert.deepStrictEqual(parseSmiLine(''), Option.none());
  });
});
