import { Result, Schema } from 'effect';
import { assert, expect, test } from 'vitest';
import { issuesOf } from './api/errors.ts';
import {
  autoTitle,
  ConversationPatch,
  contextUsed,
  DEFAULT_TITLE,
  isDefaultTitle,
  LlamaTimingsSchema,
  Sampling,
  statsFromTimings,
} from './chat.ts';
import { STRICT } from './profile.ts';

test('statsFromTimings maps llama-server timings', () => {
  const t = {
    prompt_n: 183,
    prompt_per_second: 183.21,
    predicted_n: 412,
    predicted_per_second: 51.23,
    cache_n: 12,
    draft_n: 40,
    draft_n_accepted: 20,
  };
  expect(statsFromTimings(t, 1234, 9000)).toEqual({
    ttftMs: 1234,
    promptTokens: 183,
    cachedTokens: 12,
    genTokens: 412,
    ppTps: 183.21,
    tgTps: 51.23,
    draftN: 40,
    draftAccepted: 20,
    durationMs: 9000,
  });
  const { draft_n: _d, draft_n_accepted: _a, ...plain } = t;
  expect(statsFromTimings(plain, null, 1).draftN).toBeNull();
});

test('autoTitle keeps the first six words within 48 characters', () => {
  expect(autoTitle('  Explain   the GGUF shards of llama.cpp in detail please ')).toBe(
    'Explain the GGUF shards of llama.cpp…',
  );
  expect(autoTitle('Hello')).toBe('Hello');
  expect(autoTitle('One two three four five six seven')).toBe('One two three four five six…');
  expect(autoTitle('   ')).toBe('New conversation');
  expect(autoTitle('a'.repeat(60))).toBe(`${'a'.repeat(47)}…`);
});

test('isDefaultTitle accepts the current and the legacy default title', () => {
  expect(isDefaultTitle(DEFAULT_TITLE)).toBe(true);
  expect(isDefaultTitle('Nouvelle conversation')).toBe(true);
  expect(isDefaultTitle('Explain speculative decoding')).toBe(false);
});

test('contextUsed counts the cached prompt too, not only the new tokens (#29)', () => {
  // Second turn: 1,200 tokens reused from the cache, 40 new ones, a 300-token reply.
  expect(contextUsed({ cachedTokens: 1200, promptTokens: 40, genTokens: 300 })).toBe(1540);
});

const decodeSampling = Schema.decodeUnknownResult(Sampling, STRICT);
const decodePatch = Schema.decodeUnknownResult(ConversationPatch, STRICT);

/** The issues of an input that must not decode. */
const issues = <A>(result: Result.Result<A, Schema.SchemaError>) => {
  if (Result.isSuccess(result)) throw new Error('expected the input to be refused');
  return issuesOf(result.failure.issue);
};

test("Sampling refuses a value out of its range with the label's message", () => {
  expect(issues(decodeSampling({ temperature: 6 }))).toEqual([
    { path: ['temperature'], message: 'Temperature: between 0 and 5' },
  ]);
  expect(issues(decodeSampling({ top_k: 1.5 }))).toEqual([{ path: ['top_k'], message: 'Expected an integer' }]);
  expect(issues(decodeSampling({ min_p: 'high' }))).toEqual([{ path: ['min_p'], message: 'Expected a number' }]);
  expect(issues(decodeSampling({ top_p: 0.9, mirostat: 2 }))).toEqual([{ path: ['mirostat'], message: 'unknown key' }]);
  expect(decodeSampling({ temperature: 0.7, top_k: 40, seed: -1 })).toEqual(
    Result.succeed({ temperature: 0.7, top_k: 40, seed: -1 }),
  );
});

test('ConversationPatch trims the title and refuses an empty one', () => {
  expect(decodePatch({ title: '  a  ' })).toEqual(Result.succeed({ title: 'a' }));
  expect(issues(decodePatch({ title: '   ' }))).toEqual([{ path: ['title'], message: 'Required' }]);
  expect(issues(decodePatch({ title: 'a'.repeat(201) }))).toEqual([
    { path: ['title'], message: '200 characters at most' },
  ]);
  expect(issues(decodePatch({ systemPrompt: 'a'.repeat(100_001) }))).toEqual([
    { path: ['systemPrompt'], message: 'System prompt too long' },
  ]);
  expect(issues(decodePatch({ sampling: { top_p: 2 } }))).toEqual([
    { path: ['sampling', 'top_p'], message: 'Top-p: between 0 and 1' },
  ]);
  expect(issues(decodePatch({ pinned: true }))).toEqual([{ path: ['pinned'], message: 'unknown key' }]);
});

test('statsFromTimings of decoded timings without cache_n counts 0 cached', () => {
  const decoded = Schema.decodeResult(LlamaTimingsSchema)({
    prompt_n: 40,
    prompt_per_second: 800,
    predicted_n: 300,
    predicted_per_second: 50,
  });
  assert(Result.isSuccess(decoded));
  const stats = statsFromTimings(decoded.success, null, 6000);
  expect(stats.cachedTokens).toBe(0);
  expect(stats.draftN).toBeNull();
  expect(contextUsed(stats)).toBe(340);
  // A missing field does not decode: the stats stay null rather than NaN.
  expect(Result.isFailure(Schema.decodeUnknownResult(LlamaTimingsSchema)({ prompt_n: 40 }))).toBe(true);
});
