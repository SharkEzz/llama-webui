import type { Database } from "bun:sqlite";
import type { ModelSummary } from "@llama-webui/shared";

/** Résumés GGUF déjà lus ; une entrée vaut tant que le stamp (mtime et taille de chaque partie) n'a pas changé. */
export class ModelCacheRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  get(path: string): { stamp: string; summary: ModelSummary } | null {
    const r = this.db
      .query<{ stamp: string; summary_json: string }, [string]>("SELECT stamp, summary_json FROM model_cache WHERE path = ?")
      .get(path);
    return r ? { stamp: r.stamp, summary: JSON.parse(r.summary_json) } : null;
  }

  put(path: string, stamp: string, summary: ModelSummary): void {
    this.db.run("INSERT OR REPLACE INTO model_cache(path, stamp, summary_json, read_at) VALUES (?, ?, ?, ?)", [
      path,
      stamp,
      JSON.stringify(summary),
      this.now(),
    ]);
  }

  /** Oublie les fichiers qui ne sont plus là. */
  prune(keep: Set<string>): void {
    const paths = this.db.query<{ path: string }, []>("SELECT path FROM model_cache").all();
    const drop = this.db.prepare("DELETE FROM model_cache WHERE path = ?");
    this.db.transaction(() => {
      for (const { path } of paths) if (!keep.has(path)) drop.run(path);
    })();
  }
}
