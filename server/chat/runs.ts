import { autoTitle, type ChatEvent, type ChatMessage, isDefaultTitle, statsFromTimings } from '@llama-webui/shared';
import { type LlamaTimings, probeUrl, streamChatCompletion } from 'llamacpp-js/client';
import { LlamaHttpError, LlamaStreamCutError, LlamaStreamError } from 'llamacpp-js/errors';
import type { ConversationsRepo } from '../db/conversations';
import { HttpError, notFound } from '../http';
import { buildChatRequest, llamaErrorMessage } from './request';

export interface ChatTarget {
  /** `--host` of the server, null for loopback (external server). */
  host: string | null;
  port: number;
  profileId: number | null;
  modelPath: string | null;
}

export interface ChatRunsDeps {
  repo: ConversationsRepo;
  /** llama-server ready to answer, otherwise null. */
  target(): ChatTarget | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Writes the text so far to the DB at most every `flushMs`. */
  flushMs?: number;
}

export interface ChatRun {
  /** Replays what is already written then follows live; unsubscribing never stops the generation. */
  subscribe(listener: (e: ChatEvent) => void): () => void;
  done: Promise<void>;
}

const CUT = 'llama-server cut the reply short (stopped or crashed)';

/** Why a generation failed, worded for the conversation. */
function failureMessage(e: unknown): string {
  if (e instanceof LlamaHttpError)
    return e.error ? llamaErrorMessage(e.error) : `llama-server: HTTP ${e.status}${e.body ? ` — ${e.body}` : ''}`;
  if (e instanceof LlamaStreamError) return llamaErrorMessage(e.error);
  if (e instanceof LlamaStreamCutError) return CUT;
  return `llama-server unreachable: ${e instanceof Error ? e.message : String(e)}`;
}

class Run implements ChatRun {
  private listeners = new Set<(e: ChatEvent) => void>();
  private content = '';
  private reasoning = '';
  private final: ChatMessage | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  /** DB closed (development reload): no more writes. */
  private detached = false;
  readonly done: Promise<void>;

  constructor(
    private readonly deps: Required<Omit<ChatRunsDeps, 'target'>>,
    private readonly user: ChatMessage | null,
    private readonly assistant: ChatMessage,
    private readonly baseUrl: string,
    private readonly body: Record<string, unknown>,
    onEnd: () => void,
  ) {
    this.done = this.run().finally(onEnd);
  }

  subscribe(listener: (e: ChatEvent) => void): () => void {
    listener({ type: 'start', user: this.user, assistant: this.assistant });
    if (this.content || this.reasoning)
      listener({
        type: 'delta',
        ...(this.content ? { content: this.content } : {}),
        ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      });
    if (this.final) {
      listener({ type: 'done', message: this.final });
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  /**
   * Immediate stop before the DB closes: the reply is saved as “stopped” right away and subscribers receive
   * `done` (their SSE streams close; otherwise they would stay open after a development reload).
   */
  detach(): void {
    this.stop();
    if (this.final) return;
    this.detached = true;
    this.final = this.deps.repo.updateMessage(this.assistant.id, {
      content: this.content,
      reasoning: this.reasoning,
      status: 'stopped',
    });
    this.emit({ type: 'done', message: this.final });
    this.listeners.clear();
  }

  private emit(e: ChatEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        this.listeners.delete(l);
      }
    }
  }

  private async run(): Promise<void> {
    const { repo, now, flushMs } = this.deps;
    const started = now();
    let ttft: number | null = null;
    let timings: LlamaTimings | null = null;
    let lastFlush = started;
    let status: ChatMessage['status'] = 'done';
    let error: string | null = null;
    try {
      const stream = streamChatCompletion(this.baseUrl, this.body, {
        fetch: this.deps.fetch,
        signal: this.abort.signal,
      });
      for await (const j of stream) {
        const delta = j.choices?.[0]?.delta;
        const content = delta?.content ?? '';
        const reasoning = delta?.reasoning_content ?? '';
        if (content || reasoning) {
          ttft ??= now() - started;
          this.content += content;
          this.reasoning += reasoning;
          this.emit({ type: 'delta', ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) });
          if (now() - lastFlush >= flushMs && !this.detached) {
            repo.updateMessage(this.assistant.id, { content: this.content, reasoning: this.reasoning });
            lastFlush = now();
          }
        }
        if (j.timings) timings = j.timings;
      }
    } catch (e) {
      if (this.stopped) status = 'stopped';
      else {
        status = 'error';
        error = failureMessage(e);
      }
    }
    if (this.detached) return;
    try {
      this.final = repo.updateMessage(this.assistant.id, {
        content: this.content,
        reasoning: this.reasoning,
        status,
        error,
        stats: timings ? statsFromTimings(timings, ttft, now() - started) : null,
      });
    } catch {
      // Conversation deleted during the generation.
      this.final = { ...this.assistant, content: this.content, reasoning: this.reasoning, status, error };
    }
    this.emit({ type: 'done', message: this.final });
    this.listeners.clear();
  }
}

/** Running generations, at most one per conversation; they go on without a client and are saved as they go. */
export class ChatRuns {
  private readonly runs = new Map<number, Run>();
  private readonly deps: Required<Omit<ChatRunsDeps, 'target'>>;

  constructor(private readonly o: ChatRunsDeps) {
    this.deps = { repo: o.repo, fetch: o.fetch ?? fetch, now: o.now ?? Date.now, flushMs: o.flushMs ?? 1000 };
  }

  send(conversationId: number, content: string): ChatRun {
    const text = content.trim();
    if (!text) throw new HttpError(400, 'Empty message');
    const { conv, target } = this.prepare(conversationId);
    const repo = this.deps.repo;
    const user = repo.addMessage(conversationId, { role: 'user', content: text, status: 'done' });
    if (isDefaultTitle(conv.title) && repo.messages(conversationId).filter((m) => m.role === 'user').length === 1)
      repo.setTitle(conversationId, autoTitle(text));
    return this.start(conversationId, target, user);
  }

  /** Regenerates the last reply: it (and whatever follows the user's last message) is replaced. */
  regenerate(conversationId: number): ChatRun {
    const { target } = this.prepare(conversationId);
    const repo = this.deps.repo;
    const messages = repo.messages(conversationId);
    const lastUser = messages.findLastIndex((m) => m.role === 'user');
    if (lastUser < 0) throw new HttpError(409, 'Nothing to regenerate');
    const after = messages[lastUser + 1];
    if (after) repo.deleteFrom(conversationId, after.id);
    return this.start(conversationId, target, null);
  }

  stop(conversationId: number): boolean {
    const run = this.runs.get(conversationId);
    if (!run) return false;
    run.stop();
    return true;
  }

  live(conversationId: number): ChatRun | undefined {
    return this.runs.get(conversationId);
  }

  liveIds(): number[] {
    return [...this.runs.keys()];
  }

  /** Before the DB closes: everything stops, each running reply is saved as “stopped”. */
  dispose(): void {
    for (const run of this.runs.values()) run.detach();
    this.runs.clear();
  }

  private prepare(conversationId: number) {
    const conv = this.deps.repo.conversation(conversationId);
    if (!conv) throw notFound('Conversation');
    if (this.runs.has(conversationId)) throw new HttpError(409, 'A reply is already in progress in this conversation');
    const target = this.o.target();
    if (!target) throw new HttpError(409, 'llama-server is not ready');
    return { conv, target };
  }

  private start(conversationId: number, target: ChatTarget, user: ChatMessage | null): ChatRun {
    const repo = this.deps.repo;
    // The conversation keeps the model it started with; each reply records its own.
    if (repo.conversation(conversationId)!.modelPath === null && target.modelPath !== null)
      repo.setModel(conversationId, target.profileId, target.modelPath);
    const conv = repo.conversation(conversationId)!;
    const history = repo.messages(conversationId);
    const assistant = repo.addMessage(conversationId, {
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: target.modelPath,
    });
    const run = new Run(
      this.deps,
      user,
      assistant,
      probeUrl(target.host, target.port),
      buildChatRequest(conv, history),
      () => {
        if (this.runs.get(conversationId) === run) this.runs.delete(conversationId);
      },
    );
    this.runs.set(conversationId, run);
    return run;
  }
}
