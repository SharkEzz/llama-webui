import {
  type Api,
  type ChatEvent,
  type ChatMessage,
  type ConversationDetail,
  type ConversationPatch,
  type ConversationSummary,
  defer,
} from '@llama-webui/shared';
import { Effect, Stream } from 'effect';
import type { HttpApiClient } from 'effect/http-api';
import { toast } from 'sonner';
import { create } from 'zustand';
import { call, callStream, errorTag } from './api';

/** Reply being written in the open conversation. */
export interface Streaming {
  conversationId: number;
  assistantId: number;
  content: string;
  reasoning: string;
}

interface ChatState {
  list: ReadonlyArray<ConversationSummary>;
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

/** Stream followed for the open conversation; aborting it does not stop generation on the server. */
let follow: AbortController | null = null;

/** A reply as an endpoint streams it: the events of the reply, or the endpoint's error. */
type ReplyCall = (api: HttpApiClient.ForApi<typeof Api>) => Effect.Effect<Stream.Stream<ChatEvent, unknown>, unknown>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const replace = (messages: ReadonlyArray<ChatMessage>, m: ChatMessage) => messages.map((x) => (x.id === m.id ? m : x));

export const useChat = create<ChatState>((set, get) => {
  /** Follows a stream: text accumulates and is pushed to the store only once per frame. */
  const consume = async (conversationId: number, reply: ReplyCall) => {
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
      await callStream(reply, onEvent, { signal: ctl.signal });
      // Stream ended without “done” (server restarted or cut off), or nothing running (204): reread the saved state.
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
        // Connection lost: reread the saved state. Anything else is the endpoint's refusal.
        if (errorTag(e) === 'ApiUnreachable') void get().open(conversationId);
        else toast.error(message(e));
      }
    }
  };

  return {
    list: [],
    current: null,
    streaming: null,

    loadList: async () => {
      try {
        set({ list: await call((api) => api.chat.list()) });
      } catch (e) {
        toast.error(message(e));
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
        const c = await call((api) => api.chat.get({ params: { id } }));
        set({ current: c });
        // A 204 (the reply ended meanwhile) is an empty stream: the saved state is reread.
        if (c.live)
          void consume(id, (api) =>
            api.chat.follow({ params: { id } }).pipe(Effect.map((reply) => reply ?? Stream.empty)),
          );
      } catch (e) {
        set({ current: null });
        toast.error(message(e));
      }
    },

    create: async () => {
      const c = await call((api) => api.chat.create({ payload: {} }));
      follow?.abort();
      set({ current: c, streaming: null });
      void get().loadList();
      return c.id;
    },

    patch: async (p) => {
      const cur = get().current;
      if (!cur) return;
      const c = await call((api) => api.chat.patch({ params: { id: cur.id }, payload: p }));
      if (get().current?.id === c.id) set({ current: { ...get().current!, ...c, messages: get().current!.messages } });
      if (p.title) void get().loadList();
    },

    rename: async (id, title) => {
      try {
        const c = await call((api) => api.chat.patch({ params: { id }, payload: { title } }));
        const cur = get().current;
        if (cur?.id === id) set({ current: { ...cur, title: c.title } });
        await get().loadList();
      } catch (e) {
        toast.error(message(e));
      }
    },

    remove: async (id) => {
      await call((api) => api.chat.remove({ params: { id } }));
      if (get().current?.id === id) {
        follow?.abort();
        set({ current: null, streaming: null });
      }
      await get().loadList();
    },

    send: async (text) => {
      const cur = get().current;
      if (!cur) return;
      await consume(cur.id, (api) => api.chat.send({ params: { id: cur.id }, payload: { content: text } }));
    },

    regenerate: async () => {
      const cur = get().current;
      if (!cur) return;
      await consume(cur.id, (api) => api.chat.regenerate({ params: { id: cur.id } }));
    },

    stop: async () => {
      const cur = get().current;
      if (!cur) return;
      await call((api) => api.chat.stop({ params: { id: cur.id } })).catch((e: unknown) => toast.error(message(e)));
    },
  };
});
