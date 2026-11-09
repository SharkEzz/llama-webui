import { z } from 'zod';

const num = (min: number, max: number, label: string) =>
  z
    .number({ error: 'Expected a number' })
    .min(min, `${label}: between ${min} and ${max}`)
    .max(max, `${label}: between ${min} and ${max}`);
const int = (min: number, max: number, label: string) => num(min, max, label).int({ error: 'Expected an integer' });

/** A conversation's sampling; a missing key = the server's value (the profile's). */
export const SamplingSchema = z.strictObject({
  temperature: num(0, 5, 'Temperature').optional(),
  top_p: num(0, 1, 'Top-p').optional(),
  top_k: int(0, 1000, 'Top-k').optional(),
  min_p: num(0, 1, 'Min-p').optional(),
  presence_penalty: num(-2, 2, 'Presence penalty').optional(),
  repeat_penalty: num(0, 5, 'Repeat penalty').optional(),
  max_tokens: int(1, 1_000_000, 'Max tokens').optional(),
  seed: z.number({ error: 'Expected a number' }).int({ error: 'Expected an integer' }).optional(),
});
export type Sampling = z.infer<typeof SamplingSchema>;

export const ConversationPatchSchema = z.strictObject({
  title: z.string().trim().min(1, 'Required').max(200, '200 characters at most').optional(),
  systemPrompt: z.string().max(100_000, 'System prompt too long').optional(),
  sampling: SamplingSchema.optional(),
  thinking: z.boolean().optional(),
});
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>;

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface MessageStats {
  /** Time from sending to the first token (reasoning included). */
  ttftMs: number | null;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
  ppTps: number;
  tgTps: number;
  draftN: number | null;
  draftAccepted: number | null;
  durationMs: number;
}

/**
 * Context the conversation fills after a reply: the prompt reused from the cache, the prompt evaluated, the reply.
 * `promptTokens` alone (llama-server's `prompt_n`) only counts what was not cached: from the second turn on, it is
 * the new message.
 */
export function contextUsed(s: Pick<MessageStats, 'cachedTokens' | 'promptTokens' | 'genTokens'>): number {
  return s.cachedTokens + s.promptTokens + s.genTokens;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  stats: MessageStats | null;
  /** Model that wrote the reply. */
  model: string | null;
  createdAt: number;
}

export interface Conversation {
  id: number;
  title: string;
  profileId: number | null;
  modelPath: string | null;
  systemPrompt: string;
  sampling: Sampling;
  thinking: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: number;
  title: string;
  updatedAt: number;
  messageCount: number;
  modelPath: string | null;
  live: boolean;
}

export type ConversationDetail = Conversation & { messages: ChatMessage[]; live: boolean };

export type ChatEvent =
  | { type: 'start'; user: ChatMessage | null; assistant: ChatMessage }
  | { type: 'delta'; content?: string; reasoning?: string }
  | { type: 'done'; message: ChatMessage };

/** `timings` of the last chunk of a llama-server stream. */
export interface LlamaTimings {
  prompt_n: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_per_second: number;
  cache_n?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

export function statsFromTimings(t: LlamaTimings, ttftMs: number | null, durationMs: number): MessageStats {
  return {
    ttftMs,
    promptTokens: t.prompt_n,
    cachedTokens: t.cache_n ?? 0,
    genTokens: t.predicted_n,
    ppTps: t.prompt_per_second,
    tgTps: t.predicted_per_second,
    draftN: t.draft_n ?? null,
    draftAccepted: t.draft_n_accepted ?? null,
    durationMs,
  };
}

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
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return DEFAULT_TITLE;
  let title = words.slice(0, TITLE_WORDS).join(' ');
  let cut = words.length > TITLE_WORDS;
  if (title.length > TITLE_MAX - 1 && (cut || title.length > TITLE_MAX)) {
    title = title.slice(0, TITLE_MAX - 1);
    cut = true;
  }
  return cut ? `${title}…` : title;
}
