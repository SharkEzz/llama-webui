import { Api } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AppInfo } from '../config/AppInfo.ts';

/** `GET /api/health`: the server is up, its version, its uptime and the id of this start. */
export const HealthHandlers = HttpApiBuilder.group(
  Api,
  'health',
  Effect.fn(function* (handlers) {
    const info = yield* AppInfo;
    return handlers.handle('get', () =>
      Effect.map(info.uptimeMs, (uptimeMs) => ({
        ok: true as const,
        version: info.version,
        uptimeMs,
        bootId: info.bootId,
      })),
    );
  }),
);
