import { DEFAULT_SETTINGS, type Settings, SettingsSchema } from '@llama-webui/shared';
import type { Database } from './sqlite';

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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

  /**
   * Validates the full merge before writing; throws a ZodError if invalid. An object-valued setting (`collectors`) is
   * merged field by field: `{ collectors: { nvml: false } }` leaves the other collectors as they are.
   */
  patch(partial: Record<string, unknown>): Settings {
    const current: Record<string, unknown> = this.get();
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(partial)) {
      const was = current[key];
      // Objects are merged field by field (collectors), except `env`: a variable left out is removed.
      merged[key] = key !== 'env' && isPlainObject(was) && isPlainObject(value) ? { ...was, ...value } : value;
    }
    const next = SettingsSchema.parse(merged);
    const upsert = this.db.prepare('INSERT OR REPLACE INTO settings(key, value_json) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const key of KEYS) {
        if (key in partial) upsert.run(key, JSON.stringify(next[key]));
      }
    })();
    return next;
  }
}
