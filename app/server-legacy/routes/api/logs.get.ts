import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { type QueryOf, queryOf, reply } from '../../lib/http.ts';

export type Query = QueryOf<'since'>;

export default defineHandler((event) => {
  const { runtime } = deps();
  const since = Number(queryOf(event, 'since').since ?? 0);
  return reply({
    lines: runtime.logs.since(Number.isFinite(since) ? since : 0),
    seq: runtime.logs.seq,
    bootId: runtime.bootId,
  });
});
