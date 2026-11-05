import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "@llama-webui/shared";

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get(): Settings {
    const rows = this.db
      .query<{ key: string; value_json: string }, []>("SELECT key, value_json FROM settings")
      .all();
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      if ((KEYS as string[]).includes(r.key)) stored[r.key] = JSON.parse(r.value_json);
    }
    return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...stored });
  }

  /** Valide la fusion complète avant d'écrire ; lève une ZodError si invalide. */
  patch(partial: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.get(), ...partial });
    const upsert = this.db.prepare("INSERT OR REPLACE INTO settings(key, value_json) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const key of KEYS) {
        if (key in partial) upsert.run(key, JSON.stringify(next[key]));
      }
    })();
    return next;
  }
}
