import {
  type ChatEvent,
  type ChatMessage,
  type ConversationDetail,
  type ConversationPatch,
  type ConversationSummary,
  defer,
  SseParser,
} from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { ApiError, api, apiError } from './api';

/** Reply being written in the open conversation. */
export interface Streaming {
  conversationId: number;
  assistantId: number;
  content: string;
  reasoning: string;
}

interface ChatState {
  list: ConversationSummary[];
  current: ConversationDetail | null;
  streaming: Streaming | null;
  loadList(): Promise<void>;
  /** Opens a conversation and reattaches to its in-progress reply, if any. */
  open(id: number | null): Promise<void>;
  create(): Promise<number>;
  patch(p: ConversationPatch): Promise<void>;
  rename(id: number, title: string): Promise<void>;
  remove(id: number): Promise<void>;
  send(text: string): Promise<void>;
  regenerate(): Promise<void>;
  stop(): Promise<void>;
}

/** Reads an SSE stream of ChatEvent to the end (or until aborted). */
export async function readSse(res: Response, onEvent: (e: ChatEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(JSON.parse(ev.data) as ChatEvent);
  }
}

/** Stream followed for the open conversation; aborting it does not stop generation on the server. */
let follow: AbortController | null = null;

async function postStream(path: string, body?: unknown, signal?: AbortSignal): Promise<Response | null> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw apiError(res.status, await res.json().catch(() => null));
  return res;
}

const replace = (messages: ChatMessage[], m: ChatMessage) => messages.map((x) => (x.id === m.id ? m : x));

export const useChat = create<ChatState>((set, get) => {
  /** Follows a stream: text accumulates and is pushed to the store only once per frame. */
  const consume = async (conversationId: number, request: (signal: AbortSignal) => Promise<Response | null>) => {
    follow?.abort();
    const ctl = new AbortController();
    follow = ctl;
    using _follow = defer(() => {
      if (follow === ctl) follow = null;
    });
    let pending = { content: '', reasoning: '' };
    let frame = 0;
    const flush = () => {
      frame = 0;
      const s = get().streaming;
      if (!s || s.conversationId !== conversationId) return;
      set({ streaming: { ...s, content: s.content + pending.content, reasoning: s.reasoning + pending.reasoning } });
      pending = { content: '', reasoning: '' };
    };
    let ended = false;
    const onEvent = (e: ChatEvent) => {
      if (ctl.signal.aborted) return;
      const cur = get().current;
      if (e.type === 'start') {
        if (cur?.id === conversationId) {
          // Regeneration: the last reply goes away (the server deleted it).
          let messages = e.user
            ? cur.messages
            : cur.messages.slice(0, cur.messages.findLastIndex((m) => m.role === 'user') + 1);
          for (const m of [e.user, e.assistant])
            if (m && !messages.some((x) => x.id === m.id)) messages = [...messages, m];
          set({ current: { ...cur, messages, live: true } });
        }
        pending = { content: '', reasoning: '' };
        set({ streaming: { conversationId, assistantId: e.assistant.id, content: '', reasoning: '' } });
      } else if (e.type === 'delta') {
        pending.content += e.content ?? '';
        pending.reasoning += e.reasoning ?? '';
        frame ||= requestAnimationFrame(flush);
      } else {
        ended = true;
        cancelAnimationFrame(frame);
        frame = 0;
        if (cur?.id === conversationId)
          set({ current: { ...cur, messages: replace(cur.messages, e.message), live: false } });
        set({ streaming: null });
        // The first message gives the conversation its title (server side).
        void get()
          .loadList()
          .then(() => {
            const title = get().list.find((x) => x.id === conversationId)?.title;
            const c = get().current;
            if (title && c?.id === conversationId && c.title !== title) set({ current: { ...c, title } });
          });
      }
    };
    try {
      const res = await request(ctl.signal);
      if (res) await readSse(res, onEvent);
      // Stream ended without “done” (server reloaded or cut off), or nothing running (204): reread the saved state.
      if (!ended && !ctl.signal.aborted) {
        if (get().streaming?.conversationId === conversationId) set({ streaming: null });
        if (get().current?.id === conversationId) {
          follow = null;
          set({ current: null });
          void get().open(conversationId);
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted) {
        if (get().streaming?.conversationId === conversationId) set({ streaming: null });
        if (e instanceof ApiError) toast.error(e.message);
        else void get().open(conversationId); // connection lost: reread the saved state
      }
    }
  };

  return {
    list: [],
    current: null,
    streaming: null,

    loadList: async () => {
      try {
        set({ list: await api<ConversationSummary[]>('/chat') });
      } catch (e) {
        toast.error((e as Error).message);
      }
    },

    open: async (id) => {
      if (id === null) {
        follow?.abort();
        set({ current: null, streaming: null });
        return;
      }
      if (get().current?.id === id && (get().streaming?.conversationId === id || !get().current?.live)) return;
      follow?.abort();
      set({ streaming: null });
      try {
        const c = await api<ConversationDetail>(`/chat/${id}`);
        set({ current: c });
        if (c.live) void consume(id, (signal) => postStream(`/chat/${id}/stream`, undefined, signal));
      } catch (e) {
        set({ current: null });
        toast.error((e as Error).message);
      }
    },

    create: async () => {
      const c = await api<ConversationDetail>('/chat', { method: 'POST', body: '{}' });
      follow?.abort();
      set({ current: c, streaming: null });
      void get().loadList();
      return c.id;
    },

    patch: async (p) => {
      const cur = get().current;
      if (!cur) return;
      const c = await api<ConversationDetail>(`/chat/${cur.id}`, { method: 'PATCH', body: JSON.stringify(p) });
      if (get().current?.id === c.id) set({ current: { ...get().current!, ...c, messages: get().current!.messages } });
      if (p.title) void get().loadList();
    },

    rename: async (id, title) => {
      try {
        const c = await api<ConversationDetail>(`/chat/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
        const cur = get().current;
        if (cur?.id === id) set({ current: { ...cur, title: c.title } });
        await get().loadList();
      } catch (e) {
        toast.error((e as Error).message);
      }
    },

    remove: async (id) => {
      await api(`/chat/${id}`, { method: 'DELETE' });
      if (get().current?.id === id) {
        follow?.abort();
        set({ current: null, streaming: null });
      }
      await get().loadList();
    },

    send: async (text) => {
      const cur = get().current;
      if (!cur) return;
      await consume(cur.id, (signal) => postStream(`/chat/${cur.id}/messages`, { content: text }, signal));
    },

    regenerate: async () => {
      const cur = get().current;
      if (!cur) return;
      await consume(cur.id, (signal) => postStream(`/chat/${cur.id}/regenerate`, {}, signal));
    },

    stop: async () => {
      const cur = get().current;
      if (!cur) return;
      await api(`/chat/${cur.id}/stop`, { method: 'POST', body: '{}' }).catch((e: Error) => toast.error(e.message));
    },
  };
});
