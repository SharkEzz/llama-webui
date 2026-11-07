import type { Database } from 'bun:sqlite';
import {
  type ChatMessage,
  type Conversation,
  type ConversationPatch,
  ConversationPatchSchema,
  type ConversationSummary,
  DEFAULT_TITLE,
  type MessageStats,
  type MessageStatus,
} from '@llama-webui/shared';
import { notFound } from '../http';

interface ConvRow {
  id: number;
  title: string;
  profile_id: number | null;
  model_path: string | null;
  sampling_json: string;
  system_prompt: string;
  thinking: number;
  created_at: number;
  updated_at: number;
}

interface MsgRow {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  stats_json: string | null;
  model_path: string | null;
  created_at: number;
}

const conv = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  profileId: r.profile_id,
  modelPath: r.model_path,
  systemPrompt: r.system_prompt,
  sampling: JSON.parse(r.sampling_json),
  thinking: r.thinking === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const msg = (r: MsgRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  reasoning: r.reasoning,
  status: r.status,
  error: r.error,
  stats: r.stats_json ? JSON.parse(r.stats_json) : null,
  model: r.model_path,
  createdAt: r.created_at,
});

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  model?: string | null;
}

export interface MessageUpdate {
  content?: string;
  reasoning?: string;
  status?: MessageStatus;
  error?: string | null;
  stats?: MessageStats | null;
}

/** Chat conversations and messages. */
export class ConversationsRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Omit<ConversationSummary, 'live'>[] {
    return this.db
      .query<{ id: number; title: string; updated_at: number; model_path: string | null; n: number }, []>(
        `SELECT c.id, c.title, c.updated_at, c.model_path, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n
         FROM conversations c ORDER BY c.updated_at DESC, c.id DESC`,
      )
      .all()
      .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, modelPath: r.model_path, messageCount: r.n }));
  }

  conversation(id: number): Conversation | null {
    const r = this.db.query<ConvRow, [number]>('SELECT * FROM conversations WHERE id = ?').get(id);
    return r ? conv(r) : null;
  }

  get(id: number): (Conversation & { messages: ChatMessage[] }) | null {
    const c = this.conversation(id);
    return c ? { ...c, messages: this.messages(id) } : null;
  }

  messages(conversationId: number): ChatMessage[] {
    return this.db
      .query<MsgRow, [number]>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId)
      .map(msg);
  }

  message(id: number): ChatMessage | null {
    const r = this.db.query<MsgRow, [number]>('SELECT * FROM messages WHERE id = ?').get(id);
    return r ? msg(r) : null;
  }

  create(o: { profileId: number | null; modelPath: string | null }): Conversation {
    const t = this.now();
    const r = this.db
      .query<{ id: number }, [string, number | null, string | null, number, number]>(
        "INSERT INTO conversations(title, profile_id, model_path, sampling_json, system_prompt, thinking, created_at, updated_at) VALUES (?, ?, ?, '{}', '', 1, ?, ?) RETURNING id",
      )
      .get(DEFAULT_TITLE, o.profileId, o.modelPath, t, t)!;
    return this.conversation(r.id)!;
  }

  patch(id: number, raw: unknown): Conversation {
    const p: ConversationPatch = ConversationPatchSchema.parse(raw);
    const c = this.conversation(id);
    if (!c) throw notFound('Conversation');
    this.db.run(
      'UPDATE conversations SET title = ?, system_prompt = ?, sampling_json = ?, thinking = ?, updated_at = ? WHERE id = ?',
      [
        p.title ?? c.title,
        p.systemPrompt ?? c.systemPrompt,
        JSON.stringify(p.sampling ?? c.sampling),
        (p.thinking ?? c.thinking) ? 1 : 0,
        this.now(),
        id,
      ],
    );
    return this.conversation(id)!;
  }

  /** Changes the conversation's current model (the server is serving another one). */
  setModel(id: number, profileId: number | null, modelPath: string | null): void {
    this.db.run('UPDATE conversations SET profile_id = ?, model_path = ? WHERE id = ?', [profileId, modelPath, id]);
  }

  delete(id: number): void {
    if (this.db.run('DELETE FROM conversations WHERE id = ?', [id]).changes === 0) throw notFound('Conversation');
  }

  addMessage(conversationId: number, m: NewMessage): ChatMessage {
    const t = this.now();
    const r = this.db
      .query<{ id: number }, [number, string, string, string, string | null, number]>(
        'INSERT INTO messages(conversation_id, role, content, status, model_path, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      )
      .get(conversationId, m.role, m.content, m.status, m.model ?? null, t)!;
    this.touch(conversationId);
    return this.message(r.id)!;
  }

  updateMessage(id: number, u: MessageUpdate): ChatMessage {
    const cur = this.message(id);
    if (!cur) throw notFound('Message');
    this.db.run('UPDATE messages SET content = ?, reasoning = ?, status = ?, error = ?, stats_json = ? WHERE id = ?', [
      u.content ?? cur.content,
      u.reasoning ?? cur.reasoning,
      u.status ?? cur.status,
      u.error !== undefined ? u.error : cur.error,
      u.stats !== undefined ? (u.stats ? JSON.stringify(u.stats) : null) : cur.stats ? JSON.stringify(cur.stats) : null,
      id,
    ]);
    this.touch(cur.conversationId);
    return this.message(id)!;
  }

  setTitle(id: number, title: string): void {
    this.db.run('UPDATE conversations SET title = ? WHERE id = ?', [title, id]);
  }

  /** Deletes this message and all the following ones in the conversation. */
  deleteFrom(conversationId: number, messageId: number): void {
    this.db.run('DELETE FROM messages WHERE conversation_id = ? AND id >= ?', [conversationId, messageId]);
    this.touch(conversationId);
  }

  /** After a hard stop: a reply left “streaming” becomes “interrupted”. */
  stopOrphans(): number {
    return this.db.run("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'").changes;
  }

  private touch(conversationId: number): void {
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [this.now(), conversationId]);
  }
}
