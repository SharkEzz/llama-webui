import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { ModelDetail, ModelList } from "@llama-webui/shared";
import { ModelCacheRepo } from "../db/modelCache";
import type { SettingsRepo } from "../db/settings";
import { guarded, HttpError, notFound } from "../http";
import { readModel } from "../models/gguf";
import { scanModels, toSummary } from "../models/scan";
import { weightSizes } from "../models/sizes";
import { expandHome } from "../supervisor/args";

export function modelRoutes({ db, settings }: { db: Database; settings: SettingsRepo }) {
  const cache = new ModelCacheRepo(db);
  const modelsDir = () => {
    const setting = settings.get().modelsDir;
    return { setting, dir: expandHome(setting) };
  };

  return {
    "/api/models": {
      GET: guarded(async () => {
        const { setting, dir } = modelsDir();
        const list: ModelList = {
          dir,
          setting,
          home: homedir(),
          scannedAt: Date.now(),
          models: await scanModels(dir, { cache }),
        };
        return Response.json(list);
      }),
    },
    "/api/models/info": {
      GET: guarded(async (req) => {
        const path = new URL(req.url).searchParams.get("path") ?? "";
        if (!path.startsWith("/") || !path.endsWith(".gguf"))
          throw new HttpError(400, "Chemin absolu de fichier .gguf attendu");
        if (
          !(await stat(path).then(
            (s) => s.isFile(),
            () => false,
          ))
        )
          throw notFound("Fichier");
        let info;
        try {
          info = await readModel(path);
        } catch (e) {
          throw new HttpError(422, (e as Error).message);
        }
        const { dir } = modelsDir();
        const relPath = path.startsWith(`${dir.replace(/\/+$/, "")}/`)
          ? path.slice(dir.replace(/\/+$/, "").length + 1)
          : path;
        const w = weightSizes(info.tensors);
        const detail: ModelDetail = {
          ...toSummary(info, relPath),
          tensorCount: info.tensors.length,
          weights: {
            embedBytes: w.embedBytes,
            outputBytes: w.outputBytes,
            layersBytes: w.layers.reduce((a, l) => a + l.otherBytes, 0),
            expertsBytes: w.layers.reduce((a, l) => a + l.expertsBytes, 0),
            otherBytes: w.otherBytes,
            totalBytes: w.totalBytes,
          },
        };
        return Response.json(detail);
      }),
    },
  };
}
