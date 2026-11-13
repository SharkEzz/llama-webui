import { createEventStream, type H3Event } from 'nitro/h3';
import type { AppDeps } from '../deps';
import { notFound } from '../http';
import type { ChatRun } from './runs';

const PING_MS = 15_000;

/**
 * Generation events over SSE (h3's `createEventStream`), with a regular “: ping” comment: a long prompt can be
 * processed without sending anything, and a proxy may drop a silent connection. A client that leaves only
 * unsubscribes: the generation goes on.
 */
export function sse(event: H3Event, run: ChatRun) {
  const stream = createEventStream(event);
  const ping = setInterval(() => void stream.pushComment('ping'), PING_MS);
  const leave = run.subscribe((e) => {
    const sent = stream.push({ event: e.type, data: JSON.stringify(e) });
    if (e.type === 'done') void sent.then(() => stream.close());
  });
  stream.onClosed(() => {
    clearInterval(ping);
    leave();
  });
  return stream;
}

/** A conversation with whether a reply is being generated, else 404. */
export function detail({ conversations, chatRuns }: Pick<AppDeps, 'conversations' | 'chatRuns'>, id: number) {
  const c = conversations.get(id);
  if (!c) throw notFound('Conversation');
  return { ...c, live: chatRuns.live(id) !== undefined };
}
