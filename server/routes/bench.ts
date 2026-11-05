import { type BenchKind, BenchSpecSchema, type BenchStatus } from "@llama-webui/shared";
import type { BenchRunner } from "../bench/runner";
import { listDevices } from "../bench/hardware";
import { benchBinary } from "../bench/parse";
import type { BenchRunsRepo } from "../db/benchRuns";
import type { SettingsRepo } from "../db/settings";
import { guarded, HttpError, idParam, jsonObject, notFound } from "../http";

export interface BenchRouteDeps {
  benchRuns: BenchRunsRepo;
  benchRunner: BenchRunner;
  settings: SettingsRepo;
}

const KINDS = new Set(["bench", "server"]);
const STATUSES = new Set(["running", "ok", "failed", "cancelled", "interrupted"]);

export function benchRoutes({ benchRuns, benchRunner, settings }: BenchRouteDeps) {
  return {
    "/api/bench/runs": {
      GET: guarded((req) => {
        const q = new URL(req.url).searchParams;
        const kind = q.get("kind");
        const status = q.get("status");
        const runs = benchRuns.list({
          kind: kind && KINDS.has(kind) ? (kind as BenchKind) : undefined,
          status: status && STATUSES.has(status) ? (status as BenchStatus) : undefined,
          modelPath: q.get("model") || undefined,
        });
        return Response.json({ runs, live: benchRunner.live });
      }),
      DELETE: guarded((req) => {
        if (new URL(req.url).searchParams.get("failed") !== "1") throw new HttpError(400, "?failed=1 attendu");
        return Response.json({ deleted: benchRuns.deleteFailed() });
      }),
    },
    "/api/bench/run": {
      POST: guarded(async (req) => {
        const body = await jsonObject(req);
        const spec = BenchSpecSchema.parse(body.spec);
        const run = await benchRunner.start(spec, { stopServer: body.stopServer === true });
        return Response.json(run, { status: 202 });
      }),
    },
    "/api/bench/devices": {
      GET: guarded(async () => Response.json(await listDevices(benchBinary(settings.get().binary)))),
    },
    "/api/bench/:id": {
      DELETE: guarded((req) => {
        const id = idParam(req, "Run");
        const run = benchRuns.get(id);
        if (!run) throw notFound("Run");
        if (run.status === "running") throw new HttpError(409, "Ce run tourne : annulez-le d'abord");
        benchRuns.delete(id);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/bench/:id/cancel": {
      POST: guarded((req) => {
        const id = idParam(req, "Run");
        if (!benchRunner.cancel(id)) throw new HttpError(409, "Ce run ne tourne pas");
        return new Response(null, { status: 204 });
      }),
    },
  };
}
