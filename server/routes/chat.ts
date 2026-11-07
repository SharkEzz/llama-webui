import { type ConversationDetail, type ConversationSummary, formatSse } from '@llama-webui/shared';
import type { Server } from 'bun';
import type { ChatRun, ChatRuns } from '../chat/runs';
import type { ConversationsRepo } from '../db/conversations';
import type { ProfilesRepo } from '../db/profiles';
import { guarded, HttpError, idParam, jsonObject, notFound } from '../http';
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
 * Generation events over SSE. Bun drops a silent connection after 10 s: no limit for this one, plus a regular
 * “: ping” comment (a long prompt can be processed without sending anything). A client that leaves only
 * unsubscribes: the generation goes on.
 */
function sse(req: Request, server: Server<undefined>, run: ChatRun): Response {
  server.timeout(req, 0);
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

  return {
    '/api/chat': {
      GET: guarded(() =>
        Response.json(conversations.list().map((c): ConversationSummary => ({ ...c, live: isLive(c.id) }))),
      ),
      POST: guarded(async (req) => {
        const body = await jsonObject(req);
        const id = body.profileId === undefined ? activeProfileId() : Number(body.profileId);
        if (id !== null && !Number.isInteger(id)) throw new HttpError(400, 'profileId : entier attendu');
        const profile = id !== null ? profiles.get(id) : null;
        if (id !== null && !profile) throw notFound('Profile');
        const c = conversations.create({
          profileId: profile?.id ?? null,
          modelPath: profile ? profilePaths(profile).model : null,
        });
        return Response.json(detail(c.id), { status: 201 });
      }),
    },
    '/api/chat/:id': {
      GET: guarded((req) => Response.json(detail(idParam(req, 'Conversation')))),
      PATCH: guarded(async (req) => {
        const id = idParam(req, 'Conversation');
        conversations.patch(id, await jsonObject(req));
        return Response.json(detail(id));
      }),
      DELETE: guarded(async (req) => {
        const id = idParam(req, 'Conversation');
        const run = chatRuns.live(id);
        if (run) {
          chatRuns.stop(id);
          await run.done.catch(() => {});
        }
        conversations.delete(id);
        return new Response(null, { status: 204 });
      }),
    },
    '/api/chat/:id/messages': {
      POST: guarded(async (req, server) => {
        const id = idParam(req, 'Conversation');
        const { content } = await jsonObject(req);
        if (typeof content !== 'string') throw new HttpError(400, 'content : texte attendu');
        return sse(req, server, chatRuns.send(id, content));
      }),
    },
    '/api/chat/:id/regenerate': {
      POST: guarded((req, server) => sse(req, server, chatRuns.regenerate(idParam(req, 'Conversation')))),
    },
    '/api/chat/:id/stop': {
      POST: guarded((req) => {
        if (!chatRuns.stop(idParam(req, 'Conversation'))) throw new HttpError(409, 'No reply in progress');
        return new Response(null, { status: 204 });
      }),
    },
    '/api/chat/:id/stream': {
      GET: guarded((req, server) => {
        const id = idParam(req, 'Conversation');
        const run = chatRuns.live(id);
        return run ? sse(req, server, run) : new Response(null, { status: 204 });
      }),
    },
  };
}
