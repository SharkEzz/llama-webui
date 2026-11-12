import { expect, test } from 'vitest';
import { autoTitle, contextUsed, DEFAULT_TITLE, isDefaultTitle, statsFromTimings } from './chat';

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
