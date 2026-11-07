import type { ProfilesRepo } from "../db/profiles";
import type { SettingsRepo } from "../db/settings";
import { guarded, HttpError, jsonObject, notFound } from "../http";
import { type Runtime, serverView } from "../runtime";
import { buildCommand } from "../supervisor/args";
import { getFlags } from "../supervisor/flags";

export interface ServerRouteDeps {
  runtime: Runtime;
  profiles: ProfilesRepo;
  settings: SettingsRepo;
  /** Un benchmark tourne : il a la main sur les GPU (et relance lui-même le serveur qu'il a arrêté). */
  benchBusy(): boolean;
}

export function serverRoutes({ runtime, profiles, settings, benchBusy }: ServerRouteDeps) {
  const { supervisor, logs } = runtime;
  const view = () => Response.json(serverView(supervisor));

  /**
   * Les refus du superviseur (port occupé, opération en cours…) deviennent des 409. Comparaison par nom et non par
   * instanceof : le superviseur survit à `bun --hot` et lève la classe de l'ancienne version du module.
   */
  const lifecycle = async (fn: () => Promise<void>) => {
    try {
      if (benchBusy()) throw new HttpError(409, "Un benchmark est en cours");
      await fn();
    } catch (e) {
      if (e instanceof Error && e.name === "SupervisorError") throw new HttpError(409, e.message);
      throw e;
    }
  };

  const commandFor = (profileId: unknown) => {
    const id = Number(profileId);
    const profile = Number.isInteger(id) ? profiles.get(id) : null;
    if (!profile) throw notFound("Profil");
    return buildCommand(profile, settings.get());
  };

  const remember = (profileId: number) => {
    if (settings.get().defaultProfileId !== profileId) settings.patch({ defaultProfileId: profileId });
  };

  return {
    "/api/state": {
      GET: guarded(() => Response.json({ server: serverView(supervisor), logSeq: logs.seq, bootId: runtime.bootId })),
    },
    "/api/server/state": { GET: guarded(view) },
    "/api/server/start": {
      POST: guarded(async (req) => {
        const cmd = commandFor((await jsonObject(req)).profileId);
        await lifecycle(() => supervisor.start(cmd));
        remember(cmd.profileId);
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    "/api/server/switch": {
      POST: guarded(async (req) => {
        const cmd = commandFor((await jsonObject(req)).profileId);
        await lifecycle(() => supervisor.switchTo(cmd));
        remember(cmd.profileId);
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    "/api/server/restart": {
      POST: guarded(async () => {
        const id = serverView(supervisor).profileId;
        if (id === null) throw new HttpError(409, "Aucun profil à redémarrer");
        const cmd = commandFor(id); // relu en base : les modifications du profil sont prises en compte
        await lifecycle(() => supervisor.switchTo(cmd));
        return Response.json(serverView(supervisor), { status: 202 });
      }),
    },
    "/api/server/stop": {
      POST: guarded(async () => {
        await lifecycle(() => supervisor.stop());
        return view();
      }),
    },
    "/api/server/props": {
      GET: guarded(async () => {
        const s = supervisor.state;
        if (s.kind !== "ready" && s.kind !== "external") throw new HttpError(409, "Serveur non prêt");
        let r: Response;
        try {
          r = await fetch(`http://127.0.0.1:${s.port}/props`, { signal: AbortSignal.timeout(2000) });
        } catch {
          throw new HttpError(502, "llama-server ne répond pas sur /props");
        }
        if (!r.ok) throw new HttpError(502, `llama-server /props : HTTP ${r.status}`);
        return Response.json(await r.json());
      }),
    },
    "/api/flags": {
      GET: guarded(async () => {
        const { binary } = settings.get();
        const flags = await getFlags(binary);
        if (!flags) throw new HttpError(503, `llama-server --help a échoué (${binary})`);
        return Response.json({ flags });
      }),
    },
    "/api/logs": {
      GET: guarded((req) => {
        const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
        return Response.json({
          lines: logs.since(Number.isFinite(since) ? since : 0),
          seq: logs.seq,
          bootId: runtime.bootId,
        });
      }),
    },
  };
}
