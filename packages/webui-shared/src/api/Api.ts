import { HttpApi } from 'effect/http-api';
import { HealthApi } from './HealthApi.ts';
import { RequestErrors } from './RequestErrors.ts';
import { SettingsApi } from './SettingsApi.ts';

/**
 * The HTTP API of llama-webui: the server implements it (`app/server/`), the web derives its client from it. One group
 * per domain; every milestone adds its groups here, with `.add(…)` above the two last lines: the middleware only
 * reaches the groups added before it. A payload is decoded strictly (an unknown key is an issue, every issue is
 * reported), and a request that does not decode is answered by `RequestErrors`.
 */
export class Api extends HttpApi.make('llama-webui')
  .add(HealthApi)
  .add(SettingsApi)
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error', errors: 'all' })
  .middleware(RequestErrors) {}
