import { assert, it } from '@effect/vitest';
import { Array as Arr, Effect, Stream } from 'effect';
import { expect, test } from 'vitest';
import { isIdleNoise, linesOf } from './lines.ts';

const encoder = new TextEncoder();

test('the idle loop line of -lv 4 is noise, the request lines are not (#16)', () => {
  expect(isIdleNoise('0.10.001.136 I srv  update_slots: all slots are idle')).toBe(true);
  expect(isIdleNoise('srv  update_slots: all slots are idle')).toBe(true);
  expect(isIdleNoise('0.09.989.944 I slot      release: id  0 | task 0 | stop processing: n_tokens = 364')).toBe(false);
  expect(isIdleNoise('0.00.718.579 I load_tensors:       Meta() model buffer size =  5931.79 MiB')).toBe(false);
});

it.effect('lines are rebuilt across chunks, cleaned, and the last one is flushed', () =>
  Effect.gen(function* () {
    const chunks = ['a\x1b[31mb\x1b[0m\r\n  \nc d  \n', 'e', 'f'];
    const lines = yield* Stream.runCollect(linesOf(Stream.fromIterable(Arr.map(chunks, (c) => encoder.encode(c)))));
    assert.deepStrictEqual(lines, ['ab', 'c d', 'ef']);

    // "é" is two bytes in UTF-8: the first chunk ends between them.
    const bytes = encoder.encode('café\n');
    const cut = bytes.length - 2;
    const split = yield* Stream.runCollect(linesOf(Stream.make(bytes.slice(0, cut), bytes.slice(cut))));
    assert.deepStrictEqual(split, ['café']);
  }),
);
