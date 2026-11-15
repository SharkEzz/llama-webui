import { DownloadFile, type DownloadItem, DownloadStatus, ModelKind } from '@llama-webui/shared';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';
import type { NewDownload } from '../hf/repo.ts';

const Files = Schema.fromJsonString(Schema.Array(DownloadFile));

/** A row of `downloads`, its files decoded. */
const Row = Schema.Struct({
  id: Schema.Int,
  repo: Schema.String,
  revision: Schema.String,
  variant_key: Schema.String,
  name: Schema.String,
  quant: Schema.NullOr(Schema.String),
  kind: ModelKind,
  dir: Schema.String,
  files_json: Files,
  status: DownloadStatus,
  bytes_done: Schema.Int,
  total_bytes: Schema.Int,
  error: Schema.NullOr(Schema.String),
  code: Schema.NullOr(Schema.String),
  created_at: Schema.Int,
  finished_at: Schema.NullOr(Schema.Int),
});

const fromRow = (row: typeof Row.Type): DownloadItem => ({
  id: row.id,
  repo: row.repo,
  revision: row.revision,
  key: row.variant_key,
  name: row.name,
  quant: row.quant,
  kind: row.kind,
  dir: row.dir,
  files: row.files_json,
  status: row.status,
  bytesDone: row.bytes_done,
  totalBytes: row.total_bytes,
  error: row.error,
  code: row.code,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

const encodeFiles = Schema.encodeEffect(Files);

/** The size of the files done. */
const doneBytes = (files: ReadonlyArray<DownloadFile>) =>
  Arr.reduce(files, 0, (sum, file) => (file.done ? sum + file.size : sum));

/** A status the item does not leave by itself: it has a `finishedAt`. */
const isFinal = (status: DownloadStatus) => status === 'done' || status === 'error' || status === 'canceled';

/** The Hugging Face download queue, in the `downloads` table, as the Nitro server stored it. */
export class DownloadsRepo extends Context.Service<
  DownloadsRepo,
  {
    /** A new `queued` item of `input`, none of its files done. */
    readonly create: (input: NewDownload) => Effect.Effect<DownloadItem>;
    /** `create` of each of `inputs`, in one transaction: every row is written, or none. */
    readonly createAll: (inputs: ReadonlyArray<NewDownload>) => Effect.Effect<ReadonlyArray<DownloadItem>>;
    readonly get: (id: number) => Effect.Effect<Option.Option<DownloadItem>>;
    /** Every item, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<DownloadItem>>;
    /** The queued and running items, in queue order. */
    readonly active: Effect.Effect<ReadonlyArray<DownloadItem>>;
    /** The next item to run: one left `downloading` (stopped by a restart) first, else the oldest queued. */
    readonly next: Effect.Effect<Option.Option<DownloadItem>>;
    /** Sets the status, its error and code (none when not given); a final status sets `finishedAt`, another clears it. */
    readonly setStatus: (
      id: number,
      status: DownloadStatus,
      details?: { readonly error?: string | null; readonly code?: string | null },
    ) => Effect.Effect<DownloadItem>;
    /** Marks the file at `path` done (renamed into place); `bytesDone` is the size of the files done. */
    readonly fileDone: (id: number, path: string) => Effect.Effect<DownloadItem>;
    /**
     * Back in the queue (a retry): no file is trusted done any more (a canceled item's were deleted, others may have
     * been since), so the transfer checks each one on disk again.
     */
    readonly requeue: (id: number) => Effect.Effect<DownloadItem>;
    readonly remove: (id: number) => Effect.Effect<void>;
    /** Deletes the finished items (done, error, canceled); their ids, ascending. */
    readonly clearFinished: Effect.Effect<ReadonlyArray<number>>;
  }
>()('@llama-webui/app/server/downloads/DownloadsRepo') {
  static readonly layer: Layer.Layer<DownloadsRepo, never, SqlClient.SqlClient> = Layer.effect(
    DownloadsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findById = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Row,
        execute: (id) => sql`SELECT * FROM downloads WHERE id = ${id}`,
      });
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Row,
        execute: () => sql`SELECT * FROM downloads ORDER BY id`,
      });
      const findActive = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Row,
        execute: () => sql`SELECT * FROM downloads WHERE status IN ('queued', 'downloading') ORDER BY id`,
      });
      const findNext = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Row,
        execute: () =>
          sql`SELECT * FROM downloads WHERE status IN ('queued', 'downloading')
              ORDER BY status = 'downloading' DESC, id LIMIT 1`,
      });

      /** The item of `id`: a row the queue holds the id of (one missing is a defect). */
      const byId = (id: number) =>
        findById(id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(`download ${id} is not in the table`),
              onSome: (row) => Effect.succeed(fromRow(row)),
            }),
          ),
        );

      /** Writes the files of `id` and the size of those done. */
      const writeFiles = Effect.fn('DownloadsRepo.writeFiles')(function* (
        id: number,
        files: ReadonlyArray<DownloadFile>,
      ) {
        const json = yield* encodeFiles(files);
        yield* sql`UPDATE downloads SET ${sql.update({ files_json: json, bytes_done: doneBytes(files) })} WHERE id = ${id}`;
      });

      const create = Effect.fn('DownloadsRepo.create')(
        function* (input: NewDownload) {
          const files = Arr.map(input.files, (file): DownloadFile => ({ ...file, done: false }));
          const json = yield* encodeFiles(files);
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql`INSERT INTO downloads ${sql.insert({
            repo: input.repo,
            revision: input.revision,
            variant_key: input.key,
            name: input.name,
            quant: input.quant,
            kind: input.kind,
            dir: input.dir,
            files_json: json,
            status: 'queued',
            total_bytes: Arr.reduce(files, 0, (sum, file) => sum + file.size),
            created_at: now,
          })} RETURNING *`;
          const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
          return row === undefined ? yield* Effect.die('INSERT … RETURNING gave no row') : fromRow(row);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const createAll = Effect.fn('DownloadsRepo.createAll')(
        function* (inputs: ReadonlyArray<NewDownload>) {
          return yield* Effect.forEach(inputs, create);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die }),
      );

      const get = Effect.fn('DownloadsRepo.get')(
        function* (id: number) {
          const row = yield* findById(id);
          return Option.map(row, fromRow);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const list = findAll().pipe(Effect.map(Arr.map(fromRow)), Effect.orDie, Effect.withSpan('DownloadsRepo.list'));

      const active = findActive().pipe(
        Effect.map(Arr.map(fromRow)),
        Effect.orDie,
        Effect.withSpan('DownloadsRepo.active'),
      );

      const next = findNext().pipe(
        Effect.map(Option.map(fromRow)),
        Effect.orDie,
        Effect.withSpan('DownloadsRepo.next'),
      );

      const setStatus = Effect.fn('DownloadsRepo.setStatus')(
        function* (
          id: number,
          status: DownloadStatus,
          details: { readonly error?: string | null; readonly code?: string | null } = {},
        ) {
          const now = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE downloads SET ${sql.update({
            status,
            error: details.error ?? null,
            code: details.code ?? null,
            finished_at: isFinal(status) ? now : null,
          })} WHERE id = ${id}`;
          return yield* byId(id);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const fileDone = Effect.fn('DownloadsRepo.fileDone')(
        function* (id: number, path: string) {
          const item = yield* byId(id);
          yield* writeFiles(
            id,
            Arr.map(item.files, (file) => (file.path === path ? { ...file, done: true } : file)),
          );
          return yield* byId(id);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const requeue = Effect.fn('DownloadsRepo.requeue')(
        function* (id: number) {
          const item = yield* byId(id);
          yield* writeFiles(
            id,
            Arr.map(item.files, (file) => ({ ...file, done: false })),
          );
          return yield* setStatus(id, 'queued');
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const remove = Effect.fn('DownloadsRepo.remove')(function* (id: number) {
        yield* Effect.orDie(sql`DELETE FROM downloads WHERE id = ${id}`);
      });

      const clearFinished = sql<{ readonly id: number }>`
        DELETE FROM downloads WHERE status IN ('done', 'error', 'canceled') RETURNING id`.pipe(
        Effect.map((rows) =>
          Arr.sort(
            Arr.map(rows, (row) => row.id),
            Order.Number,
          ),
        ),
        Effect.orDie,
        Effect.withSpan('DownloadsRepo.clearFinished'),
      );

      return DownloadsRepo.of({
        create,
        createAll,
        get,
        list,
        active,
        next,
        setStatus,
        fileDone,
        requeue,
        remove,
        clearFinished,
      });
    }),
  );
}
