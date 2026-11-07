import type { ChatMessage, Conversation } from '@llama-webui/shared';

/**
 * Body of /v1/chat/completions: system prompt, finished history (without reasoning or failed replies, consecutive
 * messages with the same role merged), only the sampling keys that are set (the others keep the server's values),
 * thinking enabled or not.
 */
export function buildChatRequest(conv: Conversation, history: ChatMessage[]): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (conv.systemPrompt.trim()) messages.push({ role: 'system', content: conv.systemPrompt });
  for (const m of history) {
    if ((m.status !== 'done' && m.status !== 'stopped') || m.content === '') continue;
    // A failed reply leaves two user messages in a row: merge them, since strict chat templates
    // (Gemma, Mistral…) require alternating roles.
    const prev = messages.at(-1);
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }
  const sampling = Object.fromEntries(Object.entries(conv.sampling).filter(([, v]) => v !== undefined && v !== null));
  return { messages, stream: true, ...sampling, chat_template_kwargs: { enable_thinking: conv.thinking } };
}

export interface LlamaError {
  code?: number;
  message?: string;
  type?: string;
  n_prompt_tokens?: number;
  n_ctx?: number;
}

const int = (n: number) => n.toLocaleString('en-US');

/** llama-server error (HTTP response or stream event) as a readable message; a context overflow is explained. */
export function llamaErrorMessage(e: LlamaError): string {
  if (e.type === 'exceed_context_size_error') {
    const m = /\((\d+) tokens\).*\((\d+)\s*tokens\)/.exec(e.message ?? '');
    const prompt = e.n_prompt_tokens ?? (m ? Number(m[1]) : null);
    const ctx = e.n_ctx ?? (m ? Number(m[2]) : null);
    const sizes = prompt !== null && ctx !== null ? ` (${int(prompt)} / ${int(ctx)} tokens)` : '';
    return `Conversation too long for the model's context${sizes}: start a new conversation or use a profile with a larger context.`;
  }
  return `llama-server: ${e.message ?? 'error'}`;
}
