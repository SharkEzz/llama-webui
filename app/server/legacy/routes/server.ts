import { stateHost } from '@llama-webui/shared';
import { Hono } from 'hono';
import { fetchProps, probeUrl } from 'llamacpp-js/client';
import { LlamaHttpError, LlamaReplyError } from 'llamacpp-js/errors';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import { type Env, HttpError, json, notFound, object, query } from '../http';
import { type Runtime, serverView } from '../runtime';
import { binaryPath, buildCommand } from '../supervisor/args';
import { getFlags } from '../supervisor/flags';
import { SupervisorError } from '../supervisor/supervisor';

export interface ServerRouteDeps {
  runtime: Runtime;
  profiles: ProfilesRepo;
  settings: SettingsRepo;
  /** A benchmark is running: it owns the GPUs (and restarts the server it stopped by itself). */
  benchBusy(): boolean;
}

export function serverRoutes({ runtime, profiles, settings, benchBusy }: ServerRouteDeps) {
  const { supervisor, logs } = runtime;
  /** Supervisor refusals (port in use, operation in progress…) become 409s. */
  const lifecycle = async (fn: () => Promise<void>) => {
    try {
      if (benchBusy()) throw new HttpError(409, 'A benchmark is running');
      await fn();
    } catch (e) {
      if (e instanceof SupervisorError) throw new HttpError(409, e.message);
      throw e;
    }
  };

  const commandFor = (profileId: unknown) => {
    const id = Number(profileId);
    const profile = Number.isInteger(id) ? profiles.get(id) : null;
    if (!profile) throw notFound('Profile');
    return buildCommand(profile, settings.get());
  };

  const remember = (profileId: number) => {
    if (settings.get().defaultProfileId !== profileId) settings.patch({ defaultProfileId: profileId });
  };

  return new Hono<Env>()
    .get('/api/state', (c) => c.json({ server: serverView(supervisor), logSeq: logs.seq, bootId: runtime.bootId }))
    .get('/api/server/state', (c) => c.json(serverView(supervisor)))
    .post('/api/server/start', json(object), async (c) => {
      const cmd = commandFor(c.req.valid('json').profileId);
      await lifecycle(() => supervisor.start(cmd));
      remember(cmd.profileId);
      return c.json(serverView(supervisor), 202);
    })
    .post('/api/server/switch', json(object), async (c) => {
      const cmd = commandFor(c.req.valid('json').profileId);
      await lifecycle(() => supervisor.switchTo(cmd));
      remember(cmd.profileId);
      return c.json(serverView(supervisor), 202);
    })
    .post('/api/server/restart', async (c) => {
      const id = serverView(supervisor).profileId;
      if (id === null) throw new HttpError(409, 'No profile to restart');
      const cmd = commandFor(id); // re-read from the DB: profile changes are taken into account
      await lifecycle(() => supervisor.switchTo(cmd));
      return c.json(serverView(supervisor), 202);
    })
    .post('/api/server/stop', async (c) => {
      await lifecycle(() => supervisor.stop());
      return c.json(serverView(supervisor));
    })
    .get('/api/server/props', async () => {
      const s = supervisor.state;
      if (s.kind !== 'ready' && s.kind !== 'external') throw new HttpError(409, 'Server not ready');
      let props: unknown;
      try {
        props = await fetchProps(probeUrl(stateHost(s), s.port));
      } catch (e) {
        if (e instanceof LlamaHttpError) throw new HttpError(502, `llama-server /props: HTTP ${e.status}`);
        // Its reply, not the client's request: a body that is not JSON is a 502, not a 400 "Invalid JSON".
        if (e instanceof LlamaReplyError) throw new HttpError(502, 'llama-server /props: the reply is not JSON');
        throw new HttpError(502, 'llama-server is not responding on /props');
      }
      // llama-server's own JSON, passed through untyped.
      return Response.json(props);
    })
    .get('/api/flags', async (c) => {
      const binary = binaryPath(settings.get());
      const flags = await getFlags(binary);
      if (!flags) throw new HttpError(503, `llama-server --help failed (${binary})`);
      return c.json({ flags });
    })
    .get('/api/logs', query('since'), (c) => {
      const since = Number(c.req.valid('query').since ?? 0);
      return c.json({
        lines: logs.since(Number.isFinite(since) ? since : 0),
        seq: logs.seq,
        bootId: runtime.bootId,
      });
    });
}
