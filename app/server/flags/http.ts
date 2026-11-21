import { Api } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Flags } from './Flags.ts';

/** `GET /api/flags`: the flags of the configured llama-server, without the index by name (the web rebuilds it). */
export const FlagsHandlers = HttpApiBuilder.group(
  Api,
  'flags',
  Effect.fn(function* (handlers) {
    const flags = yield* Flags;
    return handlers.handle('get', () => Effect.map(flags.catalog, (catalog) => ({ flags: catalog.flags })));
  }),
);
