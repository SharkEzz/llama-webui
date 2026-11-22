// Temporary conversations of the app's chat API: created for a scenario, recorded in state.json before use so that
// `undo` deletes them whatever happens, and replies sent through the API.
import { ApiError } from './instance.ts';
import { arr, isRecord, num } from './json.ts';
import type { Context } from './measure.ts';

/** A long Markdown reply: headings, lists, tables and code blocks, long enough to outlast every window. */
export const LONG_PROMPT =
  'Write a detailed, well-structured technical guide (at least 6000 words) on running large language models ' +
  'locally on consumer GPUs: quantization formats, KV cache, multi-GPU splits, MoE offloading and benchmarking. ' +
  'Use Markdown: headings, bullet lists, at least two tables, and at least three code blocks (bash, TypeScript and C++).';

/** A conversation titled `Profiling (temp)`, thinking off, its replies capped at `maxTokens`. */
export async function temporaryConversation(ctx: Context, maxTokens = 16_000): Promise<number> {
  const created = await ctx.instance.api('/api/chat', { body: {} });
  const id = isRecord(created) ? num(created.id, -1) : -1;
  if (id < 0) throw new Error('POST /api/chat: no conversation id in the response');
  const state = ctx.run.readState();
  ctx.run.writeState({ ...state, conversations: [...state.conversations, id] });
  await ctx.instance.api(`/api/chat/${String(id)}`, {
    method: 'PATCH',
    body: { title: 'Profiling (temp)', thinking: false, sampling: { max_tokens: maxTokens } },
  });
  return id;
}

/**
 * Sends a message: `done` settles when the reply's stream ends (its end, a stop or an error), `stop` asks the app to
 * stop the reply (none in progress is fine) and waits for that end.
 */
export function sendMessage(
  ctx: Context,
  id: number,
  content: string,
): { done: Promise<void>; stop: () => Promise<void> } {
  const path = `/api/chat/${String(id)}`;
  const done = (async () => {
    const res = await fetch(`${ctx.instance.baseUrl}${path}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const body = await res.text();
    if (!res.ok) throw new ApiError(`POST ${path}/messages: ${String(res.status)} ${body.slice(0, 200)}`, res.status);
  })();
  const stop = async () => {
    try {
      await ctx.instance.api(`${path}/stop`, { method: 'POST' });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
    await done.catch(() => undefined);
  };
  return { done, stop };
}

/** The last assistant message of a conversation: its length and stats (null for a reply stopped before its end). */
export async function lastReply(
  ctx: Context,
  id: number,
): Promise<{ chars: number; stats: { genTokens: number; tgTps: number } | null }> {
  const detail = await ctx.instance.api(`/api/chat/${String(id)}`);
  const messages = isRecord(detail) ? arr(detail.messages) : [];
  const last = messages.findLast((m) => isRecord(m) && m.role === 'assistant');
  if (!isRecord(last)) throw new Error(`conversation #${String(id)} has no reply`);
  const stats = isRecord(last.stats) ? { genTokens: num(last.stats.genTokens), tgTps: num(last.stats.tgTps) } : null;
  return { chars: typeof last.content === 'string' ? last.content.length : 0, stats };
}
