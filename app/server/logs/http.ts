import { Api } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';
import { LogRing } from './LogRing.ts';

/** `GET /api/logs`: the lines still held from `since` (0 when absent), the number of the next one, the boot id. */
export const LogsHandlers = HttpApiBuilder.group(
  Api,
  'logs',
  Effect.fn(function* (handlers) {
    const ring = yield* LogRing;
    const { bootId } = yield* AppInfo;
    return handlers.handle('list', ({ query }) =>
      Effect.all({ lines: ring.since(query.since ?? 0), seq: ring.seq, bootId: Effect.succeed(bootId) }),
    );
  }),
);
