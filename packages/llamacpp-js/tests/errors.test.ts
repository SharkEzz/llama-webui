import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextOverflow, LlamaHttpError, parseLlamaError } from '../src/errors.ts';

test('contextOverflow reads the sizes from the fields, else from the message', () => {
  assert.deepEqual(contextOverflow({ type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 8192 }), {
    promptTokens: 9000,
    contextTokens: 8192,
  });
  const message = 'the request exceeds the available context size (9000 tokens), try increasing it (8192 tokens)';
  assert.deepEqual(contextOverflow({ type: 'exceed_context_size_error', message }), {
    promptTokens: 9000,
    contextTokens: 8192,
  });
  assert.deepEqual(contextOverflow({ type: 'exceed_context_size_error' }), { promptTokens: null, contextTokens: null });
  assert.equal(contextOverflow({ type: 'server_error', message }), null);
});

test('parseLlamaError keeps only a JSON error object', () => {
  assert.deepEqual(parseLlamaError('{"error":{"message":"x"}}'), { message: 'x' });
  assert.equal(parseLlamaError('{"error":"x"}'), null);
  assert.equal(parseLlamaError('null'), null);
  assert.equal(parseLlamaError('<html>'), null);
});

test('LlamaHttpError takes the message of the JSON error, else the status', () => {
  const e = new LlamaHttpError(400, '{"error":{"message":"bad"}}');
  assert.deepEqual([e.name, e.message, e.status], ['LlamaHttpError', 'bad', 400]);
  assert.equal(new LlamaHttpError(502, '').message, 'HTTP 502');
});
