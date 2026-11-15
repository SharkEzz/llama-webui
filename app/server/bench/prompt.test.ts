import { assert, describe, it } from '@effect/vitest';
import { String as Str } from 'effect';
import { draftAcceptPct, measure } from './measure.ts';
import { promptOf } from './prompt.ts';

describe('prompt and measure', () => {
  it('promptOf repeats the paragraph up to four characters per token', () => {
    const prompt = promptOf(512);
    assert.strictEqual(prompt.length, 2048);
    assert.isTrue(Str.startsWith('The lighthouse stood at the end of the pier')(prompt));
    // The paragraph is about 300 characters: 2048 hold it more than once, and the same text comes back each time.
    assert.isAbove(Str.split(prompt, 'The lighthouse').length - 1, 1);
    assert.strictEqual(promptOf(512), prompt);
    assert.strictEqual(promptOf(1), 'The ');
  });

  it('measure is the mean and the population stddev', () => {
    assert.deepStrictEqual(measure({ values: [2, 4, 4, 4, 5, 5, 7, 9], tokens: 128 }), {
      tps: 5,
      stddev: 2,
      tokens: 128,
    });
    assert.deepStrictEqual(measure({ values: [], tokens: 0 }), { tps: 0, stddev: 0, tokens: 0 });
    assert.strictEqual(draftAcceptPct({ drafted: 3, accepted: 2 }), 66.7);
    assert.isNull(draftAcceptPct({ drafted: 0, accepted: 0 }));
  });
});
