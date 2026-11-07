import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import { guarded, HttpError, jsonObject, notFound } from '../http';
import { type Runtime, serverView } from '../runtime';
import { buildCommand } from '../supervisor/args';
import { getFlags } from '../supervisor/flags';

export interface ServerRouteDeps {
  runtime: Runtime;
  profiles: ProfilesRepo;
  settings: SettingsRepo;
  /** A benchmark is running: it owns the GPUs (and restarts the server it stopped by itself). */
  benchBusy(): boolean;
}

export function serverRoutes({ runtime, profiles, settings, benchBusy }: ServerRouteDeps) {
  const { supervisor, logs } = runtime;
  const view = () => Response.json(serverView(supervisor));

  /**
   * Supervisor refusals (port in use, operation in progress…) become 409s. Compared by name rather than with
   * instanceof: the supervisor survives `bun --hot` and throws the class from the old version of the module.
   */
  const lifecycle = async (fn: () => Promise<void>) => {
    try {
      if (benchBusy()) throw new HttpError(409, 'A benchmark is running');
      await fn();
    } catch (e) {
      if (e instanceof Error && e.name === 'SupervisorError') throw new HttpError(409, e.message);
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

  return {
    '/api/state': {
      GET: guarded(() => Response.json({ server: serverView(supervisor), logSeq: logs.seq, bootId: runtime.bootId })),
    },
    '/api/server/state': { GET: guarded(view) },
    '/api/server/start': {
      POST: guarded(async (req) => {
        const cmd = commandFor((await jsonObject(req)).profileId);
        await lifecycle(() => supervisor.start(cmd));
        remember(cmd.profileId);
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    '/api/server/switch': {
      POST: guarded(async (req) => {
        const cmd = commandFor((await jsonObject(req)).profileId);
        await lifecycle(() => supervisor.switchTo(cmd));
        remember(cmd.profileId);
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    '/api/server/restart': {
      POST: guarded(async () => {
        const id = serverView(supervisor).profileId;
        if (id === null) throw new HttpError(409, 'No profile to restart');
        const cmd = commandFor(id); // re-read from the DB: profile changes are taken into account
        await lifecycle(() => supervisor.switchTo(cmd));
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    '/api/server/stop': {
      POST: guarded(async () => {
        await lifecycle(() => supervisor.stop());
        return view();
      }),
    },
    '/api/server/props': {
      GET: guarded(async () => {
        const s = supervisor.state;
        if (s.kind !== 'ready' && s.kind !== 'external') throw new HttpError(409, 'Server not ready');
        let r: Response;
        try {
          r = await fetch(`http://127.0.0.1:${s.port}/props`, { signal: AbortSignal.timeout(2000) });
        } catch {
          throw new HttpError(502, 'llama-server is not responding on /props');
        }
        if (!r.ok) throw new HttpError(502, `llama-server /props: HTTP ${r.status}`);
        return Response.json(await r.json());
      }),
    },
    '/api/flags': {
      GET: guarded(async () => {
        const { binary } = settings.get();
        const flags = await getFlags(binary);
        if (!flags) throw new HttpError(503, `llama-server --help failed (${binary})`);
        return Response.json({ flags });
      }),
    },
    '/api/logs': {
      GET: guarded((req) => {
        const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
        return Response.json({
          lines: logs.since(Number.isFinite(since) ? since : 0),
          seq: logs.seq,
          bootId: runtime.bootId,
        });
      }),
    },
  };
}
