import { assert, describe, it } from '@effect/vitest';
import type { ChatMessage, Conversation } from '@llama-webui/shared';
import { Option } from 'effect';
import { LlamaHttpFailed, LlamaStreamCut, LlamaStreamFailed, LlamaUnreachable } from '../llama/chatStream.ts';
import { buildChatRequest, failureMessage } from './request.ts';

const conv: Conversation = {
  id: 1,
  title: 't',
  profileId: null,
  modelPath: null,
  systemPrompt: 'Answer in English.',
  sampling: { temperature: 0.2 },
  thinking: false,
  createdAt: 0,
  updatedAt: 0,
};
let n = 0;
const m = (
  role: ChatMessage['role'],
  content: string,
  status: ChatMessage['status'] = 'done',
  reasoning = '',
): ChatMessage => ({
  id: ++n,
  conversationId: 1,
  role,
  content,
  reasoning,
  status,
  error: null,
  stats: null,
  model: null,
  createdAt: 0,
});

const fmt = (v: number) => v.toLocaleString('en-US');

describe('request', () => {
  it('empty sampling sends no sampling key, reasoning and failed messages stay out', () => {
    const body = buildChatRequest(conv, [
      m('user', 'Hi'),
      m('assistant', 'Hello', 'done', 'They say hi.'),
      m('user', 'So what?'),
      m('assistant', '', 'error'),
    ]);
    assert.deepStrictEqual(body.messages, [
      { role: 'system', content: 'Answer in English.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'So what?' },
    ]);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.temperature, 0.2);
    for (const k of ['top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty', 'max_tokens', 'seed'])
      assert.isFalse(k in body);
    assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.deepStrictEqual(buildChatRequest({ ...conv, systemPrompt: '  ' }, [m('user', 'x')]).messages, [
      { role: 'user', content: 'x' },
    ]);
  });

  it("a context overflow becomes a clear message, other errors keep llama-server's text", () => {
    assert.strictEqual(
      failureMessage(
        LlamaHttpFailed.make({
          status: 400,
          body: '{"error":{}}',
          error: Option.some({
            code: 400,
            type: 'exceed_context_size_error',
            message: 'request (41234 tokens) exceeds the available context size (40000 tokens), try increasing it',
          }),
        }),
      ),
      `Conversation too long for the model's context (${fmt(41234)} / ${fmt(40000)} tokens): start a new conversation or use a profile with a larger context.`,
    );
    assert.include(
      failureMessage(
        LlamaStreamFailed.make({
          error: { type: 'exceed_context_size_error', message: '?', n_prompt_tokens: 50, n_ctx: 40 },
        }),
      ),
      `(${fmt(50)} / ${fmt(40)} tokens)`,
    );
    assert.strictEqual(
      failureMessage(LlamaStreamFailed.make({ error: { type: 'server_error', message: 'boom' } })),
      'llama-server: boom',
    );
  });

  it('consecutive messages of the same role are merged (strict templates require alternating roles)', () => {
    const body = buildChatRequest({ ...conv, systemPrompt: '' }, [
      m('user', 'Q1'),
      m('assistant', '', 'error'),
      m('user', 'Q2'),
      m('assistant', 'R2'),
    ]);
    assert.deepStrictEqual(body.messages, [
      { role: 'user', content: 'Q1\n\nQ2' },
      { role: 'assistant', content: 'R2' },
    ]);
  });

  it('stopped replies stay in the history sent to llama-server', () => {
    const body = buildChatRequest({ ...conv, systemPrompt: '', thinking: true }, [
      m('user', 'Q1'),
      m('assistant', 'half an answer', 'stopped'),
      m('user', 'Q2'),
      m('assistant', '', 'streaming'),
    ]);
    assert.deepStrictEqual(body.messages, [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'half an answer' },
      { role: 'user', content: 'Q2' },
    ]);
    assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: true });
  });

  it('failureMessage words an HTTP error without JSON, a cut stream and an unreachable server', () => {
    assert.strictEqual(
      failureMessage(LlamaHttpFailed.make({ status: 503, body: 'Loading model', error: Option.none() })),
      'llama-server: HTTP 503 — Loading model',
    );
    assert.strictEqual(
      failureMessage(LlamaHttpFailed.make({ status: 500, body: '', error: Option.none() })),
      'llama-server: HTTP 500',
    );
    assert.strictEqual(
      failureMessage(LlamaHttpFailed.make({ status: 500, body: '{"error":{}}', error: Option.some({}) })),
      'llama-server: error',
    );
    assert.strictEqual(
      failureMessage(LlamaStreamCut.make({})),
      'llama-server cut the reply short (stopped or crashed)',
    );
    assert.strictEqual(
      failureMessage(LlamaUnreachable.make({ message: 'connect ECONNREFUSED 127.0.0.1:9' })),
      'llama-server unreachable: connect ECONNREFUSED 127.0.0.1:9',
    );
  });
});
