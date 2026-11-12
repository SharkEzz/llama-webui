import { type ConversationDetail, type ConversationSummary, formatSse } from '@llama-webui/shared';
import { Hono } from 'hono';
import type { ChatRun, ChatRuns } from '../chat/runs';
import type { ConversationsRepo } from '../db/conversations';
import type { ProfilesRepo } from '../db/profiles';
import { type Env, HttpError, id, json, notFound, object } from '../http';
import { profilePaths } from '../supervisor/args';

export interface ChatRouteDeps {
  conversations: ConversationsRepo;
  profiles: ProfilesRepo;
  activeProfileId: () => number | null;
  chatRuns: ChatRuns;
}

const PING_MS = 15_000;
const enc = new TextEncoder();

/**
 * Generation events over SSE, with a regular “: ping” comment: a long prompt can be processed without sending
 * anything, and a proxy may drop a silent connection (Node's own server has no idle timeout). A client that leaves
 * only unsubscribes: the generation goes on.
 */
function sse(run: ChatRun): Response {
  let leave = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        leave();
        c.close();
      };
      ping = setInterval(() => !closed && c.enqueue(enc.encode(': ping\n\n')), PING_MS);
      leave = run.subscribe((e) => {
        if (closed) return;
        c.enqueue(enc.encode(formatSse(e.type, e)));
        if (e.type === 'done') queueMicrotask(close);
      });
    },
    cancel() {
      clearInterval(ping);
      leave();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

export function chatRoutes({ conversations, profiles, activeProfileId, chatRuns }: ChatRouteDeps) {
  const isLive = (id: number) => chatRuns.live(id) !== undefined;
  const detail = (id: number): ConversationDetail => {
    const c = conversations.get(id);
    if (!c) throw notFound('Conversation');
    return { ...c, live: isLive(id) };
  };

  return new Hono<Env>()
    .get('/api/chat', (c) =>
      c.json(conversations.list().map((c): ConversationSummary => ({ ...c, live: isLive(c.id) }))),
    )
    .post(
      '/api/chat',
      json((body): { profileId?: number | null } => {
        // Omitted: the running server's profile; null: none. `Number(null)` would be 0, a profile that never exists.
        const raw = object(body).profileId;
        if (raw !== undefined && raw !== null && !Number.isInteger(raw))
          throw new HttpError(400, 'profileId: expected an integer or null');
        return { profileId: raw as number | null | undefined };
      }),
      (c) => {
        const raw = c.req.valid('json').profileId;
        const id = raw === undefined ? activeProfileId() : raw;
        const profile = id !== null ? profiles.get(id) : null;
        if (id !== null && !profile) throw notFound('Profile');
        const created = conversations.create({
          profileId: profile?.id ?? null,
          modelPath: profile ? profilePaths(profile).model : null,
        });
        return c.json(detail(created.id), 201);
      },
    )
    .get('/api/chat/:id', id('Conversation'), (c) => c.json(detail(c.req.valid('param').id)))
    .patch('/api/chat/:id', id('Conversation'), json(object), (c) => {
      const { id } = c.req.valid('param');
      conversations.patch(id, c.req.valid('json'));
      return c.json(detail(id));
    })
    .delete('/api/chat/:id', id('Conversation'), async (c) => {
      const { id } = c.req.valid('param');
      const run = chatRuns.live(id);
      if (run) {
        chatRuns.stop(id);
        await run.done.catch(() => {});
      }
      conversations.delete(id);
      return c.body(null, 204);
    })
    .post(
      '/api/chat/:id/messages',
      id('Conversation'),
      json((body) => {
        const { content } = object(body);
        if (typeof content !== 'string') throw new HttpError(400, 'content: expected a string');
        return { content };
      }),
      (c) => sse(chatRuns.send(c.req.valid('param').id, c.req.valid('json').content)),
    )
    .post('/api/chat/:id/regenerate', id('Conversation'), (c) => sse(chatRuns.regenerate(c.req.valid('param').id)))
    .post('/api/chat/:id/stop', id('Conversation'), (c) => {
      if (!chatRuns.stop(c.req.valid('param').id)) throw new HttpError(409, 'No reply in progress');
      return c.body(null, 204);
    })
    .get('/api/chat/:id/stream', id('Conversation'), (c) => {
      const { id } = c.req.valid('param');
      if (!conversations.get(id)) throw notFound('Conversation');
      const run = chatRuns.live(id);
      return run ? sse(run) : c.body(null, 204);
    });
}
