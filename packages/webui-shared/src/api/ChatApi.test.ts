import { Result, Schema } from 'effect';
import { assert, expect, test } from 'vitest';
import type { ChatEvent, ChatMessage } from '../chat.ts';
import { ChatSseEvent } from './ChatApi.ts';

const message = (id: number, role: ChatMessage['role']): ChatMessage => ({
  id,
  conversationId: 1,
  role,
  content: role === 'user' ? 'Hello' : 'Hi there',
  reasoning: '',
  status: role === 'user' ? 'done' : 'streaming',
  error: null,
  stats: null,
  model: role === 'user' ? null : 'qwen.gguf',
  createdAt: 1_700_000_000_000,
});

const encode = Schema.encodeResult(ChatSseEvent);
const decode = Schema.decodeUnknownResult(ChatSseEvent);
const parseJson = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown));

test('a ChatEvent round-trips through its SSE event', () => {
  const events: ReadonlyArray<ChatEvent> = [
    { type: 'start', user: message(1, 'user'), assistant: message(2, 'assistant') },
    { type: 'start', user: null, assistant: message(3, 'assistant') },
    { type: 'delta', content: 'Hi' },
    { type: 'delta', reasoning: 'thinking' },
    {
      type: 'done',
      message: {
        ...message(2, 'assistant'),
        status: 'done',
        stats: {
          ttftMs: 120,
          promptTokens: 40,
          cachedTokens: 12,
          genTokens: 300,
          ppTps: 812.5,
          tgTps: 51.2,
          draftN: null,
          draftAccepted: null,
          durationMs: 6000,
        },
      },
    },
  ];
  for (const event of events) {
    const encoded = encode(event);
    assert(Result.isSuccess(encoded));
    // The SSE event is named after the type, its data the JSON of the whole event (as the Nitro server sent it).
    expect(encoded.success.event).toBe(event.type);
    expect(parseJson(encoded.success.data)).toEqual(Result.succeed(event));
    expect(decode(encoded.success)).toEqual(Result.succeed(event));
  }
});
