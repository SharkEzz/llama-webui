import { Settings, SettingsInvalid } from '@llama-webui/shared';
import { Array as Arr, Context, Effect, Layer, Predicate, Record as Rec, Schema, SchemaIssue } from 'effect';
import { SqlClient } from 'effect/sql';

type Key = keyof Settings;

/** The keys of the settings, in their order. */
const KEYS: ReadonlyArray<Key> = Rec.keys(Settings.fields);

const isKey = (key: string): key is Key => Arr.some(KEYS, (k) => k === key);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Arr.isArray(value);

const decode = Schema.decodeUnknownEffect(Settings);
const Json = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeEffect(Json);
const toJson = Schema.encodeEffect(Json);
const format = SchemaIssue.makeFormatterStandardSchemaV1();

/** `merged` as settings, or `SettingsInvalid` with the message of each field it fails on. */
const validate = (merged: Readonly<Record<string, unknown>>) =>
  decode(merged, { errors: 'all' }).pipe(
    Effect.mapError((error) =>
      SettingsInvalid.make({
        message: 'Invalid settings',
        issues: Arr.map(format(error.issue).issues, (issue) => ({
          path: Arr.map(issue.path ?? [], String),
          message: issue.message,
        })),
      }),
    ),
  );

/** `partial` over `current`: objects merge field by field (`collectors`), except `env`, replaced as a whole. */
const merge = (current: Readonly<Record<string, unknown>>, partial: Readonly<Record<string, unknown>>) =>
  Rec.map({ ...current, ...partial }, (value, key) => {
    const was = current[key];
    return key !== 'env' && key in partial && isPlainObject(was) && isPlainObject(value) ? { ...was, ...value } : value;
  });

/** The settings, stored key by key in `settings(key, value_json)`, as the Nitro server stored them. */
export class SettingsRepo extends Context.Service<
  SettingsRepo,
  {
    /** Current settings; a stored value that is unreadable or no longer valid falls back to its default (logged). */
    readonly get: Effect.Effect<Settings>;
    /**
     * Validates the merge, then writes the patched keys. Objects merge field by field (`collectors`), except `env`,
     * replaced as a whole. A key that is not a setting is ignored.
     */
    readonly patch: (partial: Readonly<Record<string, unknown>>) => Effect.Effect<Settings, SettingsInvalid>;
  }
>()('@llama-webui/app/server/settings/SettingsRepo') {
  static readonly layer: Layer.Layer<SettingsRepo, never, SqlClient.SqlClient> = Layer.effect(
    SettingsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      /** The stored value of `key`, if it is readable and valid on its own. */
      const storedValue = Effect.fn('SettingsRepo.storedValue')(function* (key: Key, json: string) {
        const value = yield* parseJson(json).pipe(
          Effect.tapError(() => Effect.logWarning(`setting “${key}” unreadable, using the default value`)),
        );
        yield* decode({ [key]: value }).pipe(
          Effect.tapError(() => Effect.logWarning(`setting “${key}” invalid, using the default value`)),
        );
        return [key, value] as const;
      });

      const get = Effect.gen(function* () {
        const rows = yield* sql<{ readonly key: string; readonly value_json: string }>`
          SELECT key, value_json FROM settings`;
        const stored = yield* Effect.forEach(rows, (row) =>
          isKey(row.key) ? Effect.option(storedValue(row.key, row.value_json)) : Effect.succeedNone,
        );
        // Each value was checked on its own: together they decode.
        return yield* decode(Rec.fromEntries(Arr.getSomes(stored)));
      }).pipe(Effect.orDie, Effect.withSpan('SettingsRepo.get'));

      // One transaction from the read to the writes: two patches at once do not lose each other's fields.
      const patch = Effect.fn('SettingsRepo.patch')(
        function* (partial: Readonly<Record<string, unknown>>) {
          const current = yield* get;
          const next = yield* validate(merge(current, partial));
          yield* Effect.forEach(
            Arr.filter(KEYS, (key) => key in partial),
            (key) =>
              toJson(next[key]).pipe(
                Effect.orDie,
                Effect.flatMap(
                  (json) => sql`INSERT OR REPLACE INTO settings(key, value_json) VALUES (${key}, ${json})`,
                ),
              ),
            { discard: true },
          );
          return next;
        },
        sql.withTransaction,
        Effect.catchTag('SqlError', (error) => Effect.die(error)),
      );

      return { get, patch };
    }),
  );
}
