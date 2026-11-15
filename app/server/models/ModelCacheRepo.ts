import { ModelSummary } from '@llama-webui/shared';
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';

/** A row of `model_cache`; its summary stays text, decoded by `get` (a stored value that does not decode is a miss). */
const Row = Schema.Struct({ stamp: Schema.String, summary_json: Schema.String });

const SummaryJson = Schema.fromJsonString(ModelSummary);
const decodeSummary = Schema.decodeUnknownEffect(SummaryJson);
const encodeSummary = Schema.encodeEffect(SummaryJson);
const encodePaths = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A summary read before, with the stamp of the parts it was read from. */
export interface CachedSummary {
  readonly stamp: string;
  readonly summary: ModelSummary;
}

/**
 * The summaries of the GGUFs already read, in the `model_cache` table the Nitro server wrote: an entry holds as long
 * as the stamp (mtime and size of each part) has not changed.
 */
export class ModelCacheRepo extends Context.Service<
  ModelCacheRepo,
  {
    /** The entry of `path`; none when there is none, or when its summary no longer decodes. */
    readonly get: (path: string) => Effect.Effect<Option.Option<CachedSummary>>;
    /** Writes (or replaces) the entry of `path`. */
    readonly put: (path: string, stamp: string, summary: ModelSummary) => Effect.Effect<void>;
    /** Forgets every path not in `keep` (the files no longer there); how many. */
    readonly prune: (keep: ReadonlyArray<string>) => Effect.Effect<number>;
  }
>()('@llama-webui/app/server/models/ModelCacheRepo') {
  static readonly layer: Layer.Layer<ModelCacheRepo, never, SqlClient.SqlClient> = Layer.effect(
    ModelCacheRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Row,
        execute: (path) => sql`SELECT stamp, summary_json FROM model_cache WHERE path = ${path}`,
      });

      const get = Effect.fn('ModelCacheRepo.get')(
        function* (path: string) {
          const row = yield* findRow(path);
          if (Option.isNone(row)) return Option.none<CachedSummary>();
          const { stamp, summary_json } = row.value;
          return yield* decodeSummary(summary_json).pipe(
            Effect.map((summary) => Option.some<CachedSummary>({ stamp, summary })),
            Effect.catchTag('SchemaError', () => Effect.succeedNone),
          );
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const put = Effect.fn('ModelCacheRepo.put')(
        function* (path: string, stamp: string, summary: ModelSummary) {
          const now = yield* Clock.currentTimeMillis;
          const json = yield* encodeSummary(summary);
          yield* sql`INSERT OR REPLACE INTO model_cache ${sql.insert({
            path,
            stamp,
            summary_json: json,
            read_at: now,
          })}`;
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const prune = Effect.fn('ModelCacheRepo.prune')(
        function* (keep: ReadonlyArray<string>) {
          const paths = yield* encodePaths(keep);
          const rows =
            yield* sql`DELETE FROM model_cache WHERE path NOT IN (SELECT value FROM json_each(${paths})) RETURNING path`;
          return rows.length;
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      return ModelCacheRepo.of({ get, put, prune });
    }),
  );
}
