import type { Database } from 'bun:sqlite';
import { DEFAULT_SETTINGS, type Settings, SettingsSchema } from '@llama-webui/shared';

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  /** Current settings; an invalid stored value (stricter schema, corrupt JSON) falls back to its default. */
  get(): Settings {
    const rows = this.db.query<{ key: string; value_json: string }, []>('SELECT key, value_json FROM settings').all();
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      const key = r.key as keyof Settings;
      if (!KEYS.includes(key)) continue;
      let value: unknown;
      try {
        value = JSON.parse(r.value_json);
      } catch {
        console.warn(`[llama-webui] setting “${key}” unreadable, using the default value`);
        continue;
      }
      if (SettingsSchema.shape[key].safeParse(value).success) merged[key] = value;
      else console.warn(`[llama-webui] setting “${key}” invalid, using the default value`);
    }
    return SettingsSchema.parse(merged);
  }

  /** Validates the full merge before writing; throws a ZodError if invalid. */
  patch(partial: Partial<Settings>): Settings {
    const next = SettingsSchema.parse({ ...this.get(), ...partial });
    const upsert = this.db.prepare('INSERT OR REPLACE INTO settings(key, value_json) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const key of KEYS) {
        if (key in partial) upsert.run(key, JSON.stringify(next[key]));
      }
    })();
    return next;
  }
}
