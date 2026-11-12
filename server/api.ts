import { Hono } from 'hono';
import type { AppDeps } from './app';
import { allowTable, apiRoutes, type Env, errorResponse, guardMw, jsonCharset } from './http';
import { benchRoutes } from './routes/bench';
import { chatRoutes } from './routes/chat';
import { hfRoutes } from './routes/hf';
import { modelRoutes } from './routes/models';
import { monitorRoutes } from './routes/monitor';
import { profileRoutes } from './routes/profiles';
import { serverRoutes } from './routes/server';
import { settingsRoutes } from './routes/settings';
import { setupRoutes } from './routes/setup';
import { sweepRoutes } from './routes/sweeps';
import { topologyRoutes } from './routes/topology';
import { tuningRoutes } from './routes/tuning';
import { APP_VERSION } from './version';

const startedAt = Date.now();

/**
 * The HTTP API (`/api/*`): one chained Hono app, one `.route()` per domain file. Every request goes through the
 * charset fix, the guard (host, origin, JSON) and the 405 table first; within a domain file, a static path is
 * registered before the `:param` pattern that would catch it (Hono matches in registration order).
 */
export function createApi(deps: AppDeps) {
  const { settings, monitor } = deps;
  const allow = allowTable();
  const api = new Hono<Env>()
    .use(jsonCharset, guardMw, allow.mw)
    .get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - startedAt }))
    .route('/', settingsRoutes({ settings, monitor }))
    .route('/', profileRoutes(deps))
    .route('/', serverRoutes({ ...deps, benchBusy: () => deps.benchRunner.busy }))
    .route('/', monitorRoutes({ monitor, bootId: deps.runtime.bootId }))
    .route('/', topologyRoutes(deps))
    .route('/', setupRoutes(deps))
    .route('/', modelRoutes(deps))
    .route('/', hfRoutes(deps))
    .route('/', tuningRoutes(deps))
    .route('/', chatRoutes(deps))
    .route('/', benchRoutes(deps))
    .route('/', sweepRoutes(deps));
  allow.load(apiRoutes(api));
  api.notFound((c) => c.json({ error: 'Unknown route' }, 404));
  api.onError((err) => errorResponse(err));
  return api;
}

export type AppType = ReturnType<typeof createApi>;
