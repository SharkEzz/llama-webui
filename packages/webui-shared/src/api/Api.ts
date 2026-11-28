import { Array as Arr } from 'effect';
import { HttpApi, OpenApi } from 'effect/http-api';
import { BenchApi } from './BenchApi.ts';
import { ChatApi } from './ChatApi.ts';
import { DownloadsApi } from './DownloadsApi.ts';
import { FlagsApi } from './FlagsApi.ts';
import { HealthApi } from './HealthApi.ts';
import { HfApi } from './HfApi.ts';
import { LogsApi } from './LogsApi.ts';
import { ModelsApi } from './ModelsApi.ts';
import { MonitorApi } from './MonitorApi.ts';
import { ProfilesApi } from './ProfilesApi.ts';
import { RequestErrors } from './RequestErrors.ts';
import { ServerApi } from './ServerApi.ts';
import { SettingsApi } from './SettingsApi.ts';
import { SetupApi } from './SetupApi.ts';
import { SweepsApi } from './SweepsApi.ts';
import { TuningApi } from './TuningApi.ts';

const API_DESCRIPTION = Arr.join(
  [
    'HTTP API of **llama-webui** — one local Node.js process serving the REST API under `/api/*`, the live push WebSocket on `/ws`, and the web UI.',
    '',
    '### Common rules',
    '- **Request guard (`RequestRefused`)**: Every `/api/*` and `/ws` request must pass the local guard: `Host` must be `localhost`, `*.localhost`, or an IP literal (`400`/`403`); if `Origin` is sent, it must equal `http://<Host>` (`403`); mutating requests with a body must send `content-type: application/json` (`415`).',
    '- **Trailing slashes**: Any `/api/*/` or `/ws/` path answers `308 Permanent Redirect` to the path without the trailing slash.',
    '- **Strict validation**: Bodies, queries and headers are decoded strictly (unknown keys are rejected, all issues are returned) with `400 RequestInvalid`. Unknown paths, unsupported methods (including `HEAD`, no `405`) and invalid `:id` path parameters return `404 RouteNotFound`.',
    '- **Error shape**: Every error is JSON `{ "_tag": "...", "message": "..." }` (plus `issues` on `RequestInvalid`/`SettingsInvalid`, or `port`/`by`/`pid` on `PortInUse`). Match on `_tag`, never on `message` text.',
    '- **Channels**: Background operations (`202`) push live progress over `/ws`. Chat generations stream Server-Sent Events (`text/event-stream`) with `event: start | delta | done`, JSON `data`, and `: ping` comments every 15 seconds.',
  ],
  '\n',
);

/**
 * The HTTP API of llama-webui: the server implements it (`app/server/`), the web derives its client from it. One group
 * per domain; every milestone adds its groups here, with `.add(…)` above the two last lines: the middleware only
 * reaches the groups added before it. A payload is decoded strictly (an unknown key is an issue, every issue is
 * reported), and a request that does not decode is answered by `RequestErrors`.
 */
export class Api extends HttpApi.make('llama-webui')
  .add(HealthApi)
  .add(SettingsApi)
  .add(ProfilesApi)
  .add(FlagsApi)
  .add(LogsApi)
  .add(ServerApi)
  .add(MonitorApi)
  .add(ChatApi)
  .add(ModelsApi)
  .add(HfApi)
  .add(DownloadsApi)
  .add(BenchApi)
  .add(SweepsApi)
  .add(TuningApi)
  .add(SetupApi)
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error', errors: 'all' })
  .annotateMerge(OpenApi.annotations({ title: 'llama-webui API', description: API_DESCRIPTION }))
  .middleware(RequestErrors) {}
