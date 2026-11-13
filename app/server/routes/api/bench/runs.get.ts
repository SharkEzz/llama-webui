import type { BenchKind, BenchStatus } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { MAX_RUNS } from '../../../lib/db/benchRuns.ts';
import { type QueryOf, queryOf, reply } from '../../../lib/http.ts';

export type Query = QueryOf<'kind' | 'status' | 'sweep' | 'limit' | 'model'>;

const KINDS = new Set(['bench', 'server']);
const STATUSES = new Set(['queued', 'running', 'ok', 'failed', 'cancelled', 'interrupted']);

export default defineHandler((event) => {
  const { benchRuns, benchRunner } = deps();
  const q = queryOf(event, 'kind', 'status', 'sweep', 'limit', 'model');
  const { kind, status, sweep } = q;
  const limit = Number(q.limit);
  const runs = benchRuns.list({
    kind: kind && KINDS.has(kind) ? (kind as BenchKind) : undefined,
    status: status && STATUSES.has(status) ? (status as BenchStatus) : undefined,
    modelPath: q.model || undefined,
    // By default: one-off runs only; “all” or a sweep id for the others.
    sweepId: sweep === 'all' ? 'all' : sweep && /^\d+$/.test(sweep) ? Number(sweep) : 'none',
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RUNS) : undefined,
  });
  return reply({ runs, live: benchRunner.live });
});
