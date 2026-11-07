import { z } from "zod";

const num = (min: number, max: number, label: string) =>
  z
    .number({ error: "Nombre attendu" })
    .min(min, `${label} : entre ${min} et ${max}`)
    .max(max, `${label} : entre ${min} et ${max}`);
const int = (min: number, max: number, label: string) => num(min, max, label).int({ error: "Nombre entier attendu" });

/** Sampling d'une conversation ; une clé absente = valeur du serveur (celle du profil). */
export const SamplingSchema = z.strictObject({
  temperature: num(0, 5, "Température").optional(),
  top_p: num(0, 1, "Top-p").optional(),
  top_k: int(0, 1000, "Top-k").optional(),
  min_p: num(0, 1, "Min-p").optional(),
  presence_penalty: num(-2, 2, "Pénalité de présence").optional(),
  repeat_penalty: num(0, 5, "Pénalité de répétition").optional(),
  max_tokens: int(1, 1_000_000, "Jetons max").optional(),
  seed: z.number({ error: "Nombre attendu" }).int({ error: "Nombre entier attendu" }).optional(),
});
export type Sampling = z.infer<typeof SamplingSchema>;

export const ConversationPatchSchema = z.strictObject({
  title: z.string().trim().min(1, "Obligatoire").max(200, "200 caractères au plus").optional(),
  systemPrompt: z.string().max(100_000, "Prompt système trop long").optional(),
  sampling: SamplingSchema.optional(),
  thinking: z.boolean().optional(),
});
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>;

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export interface MessageStats {
  /** Délai entre l'envoi et le premier jeton (réflexion comprise). */
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

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  stats: MessageStats | null;
  /** Modèle qui a écrit la réponse. */
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
  | { type: "start"; user: ChatMessage | null; assistant: ChatMessage }
  | { type: "delta"; content?: string; reasoning?: string }
  | { type: "done"; message: ChatMessage };

/** `timings` du dernier morceau d'un stream llama-server. */
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

export const DEFAULT_TITLE = "Nouvelle conversation";
const TITLE_WORDS = 6;
const TITLE_MAX = 48;

/** Titre tiré du premier message : 6 mots au plus, 48 caractères au plus, « … » si coupé. */
export function autoTitle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return DEFAULT_TITLE;
  let title = words.slice(0, TITLE_WORDS).join(" ");
  let cut = words.length > TITLE_WORDS;
  if (title.length > TITLE_MAX - 1 && (cut || title.length > TITLE_MAX)) {
    title = title.slice(0, TITLE_MAX - 1);
    cut = true;
  }
  return cut ? `${title}…` : title;
}
