import { defineErrorHandler } from 'nitro';
import { log } from './log.ts';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export default defineErrorHandler((error, event) => {
  const e = error as unknown as { cause?: unknown; status?: number; constructor: { name: string } };
  const cause = e.cause as { constructor?: { name: string } } | undefined;
  log(`errorHandler error=${e.constructor.name} status=${e.status} cause=${cause?.constructor?.name} path=${event.url.pathname}`);
  const orig = cause instanceof HttpError ? cause : error instanceof HttpError ? error : null;
  if (orig) return Response.json({ error: orig.message, code: orig.code }, { status: orig.status });
  if (e.status === 405 || e.status === 404) {
    return Response.json({ error: `nitro ${e.status}`, raw: error.message }, { status: e.status, headers: (error as { headers?: HeadersInit }).headers });
  }
});
