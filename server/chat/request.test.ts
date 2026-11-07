import { expect, test } from 'bun:test';
import type { ChatMessage, Conversation } from '@llama-webui/shared';
import { buildChatRequest, llamaErrorMessage } from './request';

const conv: Conversation = {
  id: 1,
  title: 't',
  profileId: null,
  modelPath: null,
  systemPrompt: 'Réponds en français.',
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

test('empty sampling sends no sampling key, reasoning and failed messages stay out', () => {
  const body = buildChatRequest(conv, [
    m('user', 'Salut'),
    m('assistant', 'Bonjour', 'done', 'Il dit bonjour.'),
    m('user', 'Et alors ?'),
    m('assistant', '', 'error'),
  ]);
  expect(body.messages).toEqual([
    { role: 'system', content: 'Réponds en français.' },
    { role: 'user', content: 'Salut' },
    { role: 'assistant', content: 'Bonjour' },
    { role: 'user', content: 'Et alors ?' },
  ]);
  expect(body.stream).toBe(true);
  expect(body.temperature).toBe(0.2);
  for (const k of ['top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty', 'max_tokens', 'seed'])
    expect(k in body).toBe(false);
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(buildChatRequest({ ...conv, systemPrompt: '  ' }, [m('user', 'x')]).messages).toEqual([
    { role: 'user', content: 'x' },
  ]);
});

test("a context overflow becomes a clear message, other errors keep llama-server's text", () => {
  const n = (v: number) => v.toLocaleString('fr-FR');
  expect(
    llamaErrorMessage({
      code: 400,
      type: 'exceed_context_size_error',
      message: 'request (41234 tokens) exceeds the available context size (40000 tokens), try increasing it',
    }),
  ).toBe(
    `Conversation trop longue pour le contexte du modèle (${n(41234)} / ${n(40000)} jetons) : commencez une nouvelle conversation ou utilisez un profil à plus grand contexte.`,
  );
  expect(
    llamaErrorMessage({ type: 'exceed_context_size_error', message: '?', n_prompt_tokens: 50, n_ctx: 40 }),
  ).toContain(`(${n(50)} / ${n(40)} jetons)`);
  expect(llamaErrorMessage({ type: 'server_error', message: 'boom' })).toBe('llama-server : boom');
});

test('consecutive messages of the same role are merged (strict templates require alternating roles)', () => {
  const body = buildChatRequest({ ...conv, systemPrompt: '' }, [
    m('user', 'Q1'),
    m('assistant', '', 'error'),
    m('user', 'Q2'),
    m('assistant', 'R2'),
  ]);
  expect(body.messages).toEqual([
    { role: 'user', content: 'Q1\n\nQ2' },
    { role: 'assistant', content: 'R2' },
  ]);
});
