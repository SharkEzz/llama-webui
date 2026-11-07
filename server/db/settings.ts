import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, type Settings, SettingsSchema } from "@llama-webui/shared";

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  /** Réglages courants ; une valeur stockée invalide (schéma durci, JSON abîmé) retombe sur son défaut. */
  get(): Settings {
    const rows = this.db.query<{ key: string; value_json: string }, []>("SELECT key, value_json FROM settings").all();
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      const key = r.key as keyof Settings;
      if (!KEYS.includes(key)) continue;
      let value: unknown;
      try {
        value = JSON.parse(r.value_json);
      } catch {
        console.warn(`[llama-webui] réglage « ${key} » illisible, valeur par défaut utilisée`);
        continue;
      }
      if (SettingsSchema.shape[key].safeParse(value).success) merged[key] = value;
      else console.warn(`[llama-webui] réglage « ${key} » invalide, valeur par défaut utilisée`);
    }
    return SettingsSchema.parse(merged);
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
