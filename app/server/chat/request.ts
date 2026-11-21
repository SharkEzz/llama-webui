import { type ChatMessage, type Conversation, fmtInt } from '@llama-webui/shared';
import { Array as Arr, Match, Option, Order, Predicate, Record as Rec, String as Str } from 'effect';
import { dual } from 'effect/Function';
import { contextOverflow } from 'llamacpp-js/errors';
import type { ChatStreamFailure, LlamaError } from '../llama/chatStream.ts';

/** One message of the request: a system prompt or a turn of the conversation. */
export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** The body of `/v1/chat/completions`; the sampling keys that are set sit next to these. */
export interface ChatRequest {
  readonly messages: ReadonlyArray<ChatTurn>;
  readonly stream: true;
  readonly chat_template_kwargs: { readonly enable_thinking: boolean };
  readonly [key: string]: unknown;
}

/** A finished message, a stopped one included, with something to send. */
const sent = (m: ChatMessage): boolean => (m.status === 'done' || m.status === 'stopped') && Str.isNonEmpty(m.content);

const byId = Order.mapInput(Order.Number, (m: ChatMessage) => m.id);

/**
 * Appends `m` to the turns, merged into the last one when it has the same role: a failed reply leaves two user
 * messages in a row, and strict chat templates (Gemma, Mistral…) require alternating roles.
 */
const appendTurn = (turns: ReadonlyArray<ChatTurn>, m: ChatMessage): ReadonlyArray<ChatTurn> =>
  Option.match(Arr.last(turns), {
    onNone: () => Arr.append(turns, { role: m.role, content: m.content }),
    onSome: (last) =>
      last.role === m.role
        ? Arr.append(Arr.dropRight(turns, 1), { role: m.role, content: `${last.content}\n\n${m.content}` })
        : Arr.append(turns, { role: m.role, content: m.content }),
  });

/**
 * The body of `/v1/chat/completions`: the system prompt when not blank, the finished history by id (without reasoning,
 * failed replies or the reply being written; consecutive messages of one role merged), only the sampling keys that
 * are set (the others keep the server's values), `stream: true` and whether the model thinks.
 */
export const buildChatRequest: {
  (history: ReadonlyArray<ChatMessage>): (conversation: Conversation) => ChatRequest;
  (conversation: Conversation, history: ReadonlyArray<ChatMessage>): ChatRequest;
} = dual(2, (conversation: Conversation, history: ReadonlyArray<ChatMessage>): ChatRequest => {
  const system: ReadonlyArray<ChatTurn> = Str.isNonEmpty(Str.trim(conversation.systemPrompt))
    ? [{ role: 'system', content: conversation.systemPrompt }]
    : [];
  const messages = Arr.reduce(Arr.filter(Arr.sort(history, byId), sent), system, appendTurn);
  const sampling = Rec.filter<string, number | undefined>(conversation.sampling, Predicate.isNotNullish);
  return { messages, stream: true, ...sampling, chat_template_kwargs: { enable_thinking: conversation.thinking } };
});

/** llama-server's JSON error worded for the conversation; a context overflow is explained. */
const llamaErrorMessage = (error: LlamaError): string => {
  const overflow = contextOverflow(error);
  if (overflow === null) return `llama-server: ${error.message ?? 'error'}`;
  const { promptTokens: prompt, contextTokens: ctx } = overflow;
  const sizes = prompt !== null && ctx !== null ? ` (${fmtInt(prompt)} / ${fmtInt(ctx)} tokens)` : '';
  return `Conversation too long for the model's context${sizes}: start a new conversation or use a profile with a larger context.`;
};

/** Why a reply failed, worded for the conversation. */
export const failureMessage: (failure: ChatStreamFailure) => string = Match.type<ChatStreamFailure>().pipe(
  Match.tagsExhaustive({
    LlamaHttpFailed: (failure) =>
      Option.match(failure.error, {
        onSome: llamaErrorMessage,
        onNone: () => `llama-server: HTTP ${failure.status}${Str.isNonEmpty(failure.body) ? ` — ${failure.body}` : ''}`,
      }),
    LlamaStreamFailed: (failure) => llamaErrorMessage(failure.error),
    LlamaStreamCut: () => 'llama-server cut the reply short (stopped or crashed)',
    LlamaUnreachable: (failure) => `llama-server unreachable: ${failure.message}`,
  }),
);
