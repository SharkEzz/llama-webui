import type { ChatMessage, Conversation } from "@llama-webui/shared";

/**
 * Corps de /v1/chat/completions : prompt système, historique terminé (sans réflexion ni réponses en erreur), seules les
 * clés de sampling renseignées (les autres restent celles du serveur), réflexion activée ou non.
 */
export function buildChatRequest(conv: Conversation, history: ChatMessage[]): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (conv.systemPrompt.trim()) messages.push({ role: "system", content: conv.systemPrompt });
  for (const m of history) {
    if ((m.status === "done" || m.status === "stopped") && m.content !== "") messages.push({ role: m.role, content: m.content });
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

const fr = (n: number) => n.toLocaleString("fr-FR");

/** Erreur de llama-server (réponse HTTP ou événement du flux) en message lisible ; le dépassement de contexte est expliqué. */
export function llamaErrorMessage(e: LlamaError): string {
  if (e.type === "exceed_context_size_error") {
    const m = /\((\d+) tokens\).*\((\d+)\s*tokens\)/.exec(e.message ?? "");
    const prompt = e.n_prompt_tokens ?? (m ? Number(m[1]) : null);
    const ctx = e.n_ctx ?? (m ? Number(m[2]) : null);
    const sizes = prompt !== null && ctx !== null ? ` (${fr(prompt)} / ${fr(ctx)} jetons)` : "";
    return `Conversation trop longue pour le contexte du modèle${sizes} : commencez une nouvelle conversation ou utilisez un profil à plus grand contexte.`;
  }
  return `llama-server : ${e.message ?? "erreur"}`;
}
