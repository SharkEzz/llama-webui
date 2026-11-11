import { expect, test } from 'bun:test';
import { contextOverflow, LlamaHttpError, parseLlamaError } from './errors.ts';

test('contextOverflow reads the sizes from the fields, else from the message', () => {
  expect(contextOverflow({ type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 8192 })).toEqual({
    promptTokens: 9000,
    contextTokens: 8192,
  });
  const message = 'the request exceeds the available context size (9000 tokens), try increasing it (8192 tokens)';
  expect(contextOverflow({ type: 'exceed_context_size_error', message })).toEqual({
    promptTokens: 9000,
    contextTokens: 8192,
  });
  expect(contextOverflow({ type: 'exceed_context_size_error' })).toEqual({ promptTokens: null, contextTokens: null });
  expect(contextOverflow({ type: 'server_error', message })).toBeNull();
});

test('parseLlamaError keeps only a JSON error object', () => {
  expect(parseLlamaError('{"error":{"message":"x"}}')).toEqual({ message: 'x' });
  expect(parseLlamaError('{"error":"x"}')).toBeNull();
  expect(parseLlamaError('null')).toBeNull();
  expect(parseLlamaError('<html>')).toBeNull();
});

test('LlamaHttpError takes the message of the JSON error, else the status', () => {
  const e = new LlamaHttpError(400, '{"error":{"message":"bad"}}');
  expect([e.name, e.message, e.status]).toEqual(['LlamaHttpError', 'bad', 400]);
  expect(new LlamaHttpError(502, '').message).toBe('HTTP 502');
});
