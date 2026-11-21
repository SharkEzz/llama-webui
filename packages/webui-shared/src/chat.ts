import { Array as Arr, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';
import type { LlamaTimings } from 'llamacpp-js/client';

/** A number in `[minimum, maximum]`: `Expected a number` when it is none, `<label>: between <min> and <max>` out of it. */
const Between = (minimum: number, maximum: number, label: string) =>
  Schema.Number.annotate({ message: 'Expected a number' }).check(
    Schema.isFinite({ message: 'Expected a number' }),
    Schema.isBetween({ minimum, maximum }, { message: `${label}: between ${minimum} and ${maximum}` }),
  );

/** An integer in `[minimum, maximum]`: `Expected an integer` when it has a fraction. */
const IntBetween = (minimum: number, maximum: number, label: string) =>
  Between(minimum, maximum, label).check(Schema.isInt({ message: 'Expected an integer' }));

/** A conversation's sampling as a person sets it; a missing key = the server's value (the profile's). */
export const Sampling = Schema.Struct({
  temperature: Schema.optionalKey(Between(0, 5, 'Temperature')),
  top_p: Schema.optionalKey(Between(0, 1, 'Top-p')),
  top_k: Schema.optionalKey(IntBetween(0, 1000, 'Top-k')),
  min_p: Schema.optionalKey(Between(0, 1, 'Min-p')),
  presence_penalty: Schema.optionalKey(Between(-2, 2, 'Presence penalty')),
  repeat_penalty: Schema.optionalKey(Between(0, 5, 'Repeat penalty')),
  max_tokens: Schema.optionalKey(IntBetween(1, 1_000_000, 'Max tokens')),
  seed: Schema.optionalKey(
    Schema.Number.annotate({ message: 'Expected a number' }).check(
      Schema.isFinite({ message: 'Expected a number' }),
      Schema.isInt({ message: 'Expected an integer' }),
    ),
  ),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type Sampling = typeof Sampling.Type;

/**
 * A conversation's sampling as it is stored: the keys of `Sampling` without its limits (a reply carries what the table
 * holds, and a row a limit now refuses must still be read).
 */
export const StoredSampling = Schema.Struct({
  temperature: Schema.optionalKey(Schema.Finite),
  top_p: Schema.optionalKey(Schema.Finite),
  top_k: Schema.optionalKey(Schema.Int),
  min_p: Schema.optionalKey(Schema.Finite),
  presence_penalty: Schema.optionalKey(Schema.Finite),
  repeat_penalty: Schema.optionalKey(Schema.Finite),
  max_tokens: Schema.optionalKey(Schema.Int),
  seed: Schema.optionalKey(Schema.Int),
});
export type StoredSampling = typeof StoredSampling.Type;

/** What a `PATCH` of a conversation changes: each key is optional, `sampling` replaces the whole sampling. */
export const ConversationPatch = Schema.Struct({
  title: Schema.optionalKey(
    Schema.Trim.check(
      Schema.isMinLength(1, { message: 'Required' }),
      Schema.isMaxLength(200, { message: '200 characters at most' }),
    ),
  ),
  systemPrompt: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(100_000, { message: 'System prompt too long' })),
  ),
  sampling: Schema.optionalKey(Sampling),
  thinking: Schema.optionalKey(Schema.Boolean),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type ConversationPatch = typeof ConversationPatch.Type;

export const MessageStatus = Schema.Literals(['streaming', 'done', 'stopped', 'error']);
export type MessageStatus = typeof MessageStatus.Type;

/** The measures of a reply, from llama-server's `timings` and the server's clock. */
export const MessageStats = Schema.Struct({
  /** Time from sending to the first token (reasoning included). */
  ttftMs: Schema.NullOr(Schema.Finite),
  promptTokens: Schema.Finite,
  cachedTokens: Schema.Finite,
  genTokens: Schema.Finite,
  ppTps: Schema.Finite,
  tgTps: Schema.Finite,
  draftN: Schema.NullOr(Schema.Finite),
  draftAccepted: Schema.NullOr(Schema.Finite),
  durationMs: Schema.Finite,
});
export type MessageStats = typeof MessageStats.Type;

/**
 * Context the conversation fills after a reply: the prompt reused from the cache, the prompt evaluated, the reply.
 * `promptTokens` alone (llama-server's `prompt_n`) only counts what was not cached: from the second turn on, it is
 * the new message.
 */
export function contextUsed(s: Pick<MessageStats, 'cachedTokens' | 'promptTokens' | 'genTokens'>): number {
  return s.cachedTokens + s.promptTokens + s.genTokens;
}

export const ChatMessage = Schema.Struct({
  id: Schema.Int,
  conversationId: Schema.Int,
  role: Schema.Literals(['user', 'assistant']),
  content: Schema.String,
  reasoning: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  stats: Schema.NullOr(MessageStats),
  /** Model that wrote the reply. */
  model: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
});
export type ChatMessage = typeof ChatMessage.Type;

export const Conversation = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  profileId: Schema.NullOr(Schema.Int),
  modelPath: Schema.NullOr(Schema.String),
  systemPrompt: Schema.String,
  sampling: StoredSampling,
  thinking: Schema.Boolean,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type Conversation = typeof Conversation.Type;

/** A line of the conversation list; `live` while a reply is being written. */
export const ConversationSummary = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  updatedAt: Schema.Int,
  messageCount: Schema.Int,
  modelPath: Schema.NullOr(Schema.String),
  live: Schema.Boolean,
});
export type ConversationSummary = typeof ConversationSummary.Type;

/** A conversation with its messages; `live` while a reply is being written. */
export const ConversationDetail = Schema.Struct({
  ...Conversation.fields,
  messages: Schema.Array(ChatMessage),
  live: Schema.Boolean,
});
export type ConversationDetail = typeof ConversationDetail.Type;

/**
 * One event of a reply: `start` (the user message, null on a regeneration, and the empty reply), `delta` (text and
 * reasoning as they come), `done` (the reply as saved).
 */
export const ChatEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('start'), user: Schema.NullOr(ChatMessage), assistant: ChatMessage }),
  Schema.Struct({
    type: Schema.Literal('delta'),
    content: Schema.optionalKey(Schema.String),
    reasoning: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('done'), message: ChatMessage }),
]);
export type ChatEvent = typeof ChatEvent.Type;

/**
 * The `timings` of the last chunk of a llama-server stream, as far as `statsFromTimings` reads them: a chunk without
 * one of the required fields does not decode, and its reply keeps null stats rather than a NaN.
 */
export const LlamaTimingsSchema = Schema.Struct({
  prompt_n: Schema.Finite,
  prompt_per_second: Schema.Finite,
  predicted_n: Schema.Finite,
  predicted_per_second: Schema.Finite,
  cache_n: Schema.optionalKey(Schema.Finite),
  draft_n: Schema.optionalKey(Schema.Finite),
  draft_n_accepted: Schema.optionalKey(Schema.Finite),
});
export type LlamaTimingsSchema = typeof LlamaTimingsSchema.Type;

/** The stats of a reply from the `timings` of the last chunk of a llama-server stream, its ttft and its duration. */
export const statsFromTimings: {
  (ttftMs: number | null, durationMs: number): (t: LlamaTimings) => MessageStats;
  (t: LlamaTimings, ttftMs: number | null, durationMs: number): MessageStats;
} = dual(
  3,
  (t: LlamaTimings, ttftMs: number | null, durationMs: number): MessageStats => ({
    ttftMs,
    promptTokens: t.prompt_n,
    cachedTokens: t.cache_n ?? 0,
    genTokens: t.predicted_n,
    ppTps: t.prompt_per_second,
    tgTps: t.predicted_per_second,
    draftN: t.draft_n ?? null,
    draftAccepted: t.draft_n_accepted ?? null,
    durationMs,
  }),
);

export const DEFAULT_TITLE = 'New conversation';
/** Default titles from earlier versions, still present in existing databases. */
const LEGACY_DEFAULT_TITLES: readonly string[] = ['Nouvelle conversation'];
/** True when the conversation still has its default title (current or legacy) and can be auto-titled. */
export const isDefaultTitle = (title: string): boolean =>
  title === DEFAULT_TITLE || LEGACY_DEFAULT_TITLES.includes(title);
const TITLE_WORDS = 6;
const TITLE_MAX = 48;

/** Title taken from the first message: at most 6 words, at most 48 characters, “…” if truncated. */
export function autoTitle(text: string): string {
  const words = Arr.filter(Str.split(Str.trim(text), /\s+/), Str.isNonEmpty);
  if (!Arr.isReadonlyArrayNonEmpty(words)) return DEFAULT_TITLE;
  const first = Arr.join(Arr.take(words, TITLE_WORDS), ' ');
  const dropped = words.length > TITLE_WORDS;
  const tooLong = first.length > TITLE_MAX - 1 && (dropped || first.length > TITLE_MAX);
  const title = tooLong ? Str.slice(0, TITLE_MAX - 1)(first) : first;
  return dropped || tooLong ? `${title}…` : title;
}
