import { type Profile, type ProfileInput, ProfileNameTaken, ProfileNotFound, ProfileSource } from '@llama-webui/shared';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';

/** A row of `profiles`, its JSON columns decoded. */
const Row = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  model_path: Schema.String,
  mmproj_path: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  host: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
  args_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  env_json: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  source: ProfileSource,
  created_at: Schema.Int,
  updated_at: Schema.Int,
});

/** A NULL column gives no key: a stored profile carries an optional field only when it is set. */
const fromRow = (row: typeof Row.Type): Profile => ({
  id: row.id,
  name: row.name,
  model: row.model_path,
  ...(row.mmproj_path === null ? {} : { mmproj: row.mmproj_path }),
  ...(row.cwd === null ? {} : { cwd: row.cwd }),
  ...(row.host === null ? {} : { host: row.host }),
  ...(row.port === null ? {} : { port: row.port }),
  args: row.args_json,
  env: row.env_json,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const encodeArgs = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeEnv = Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)));

const notFound = () => ProfileNotFound.make({ message: 'Profile not found' });
const nameTaken = (name: string) => ProfileNameTaken.make({ message: `A profile named “${name}” already exists` });

/** The name of the `n`th copy of `name`: `<name> (copy)`, then `<name> (copy 2)`… */
const copyName = (name: string, n: number) => (n === 1 ? `${name} (copy)` : `${name} (copy ${n})`);

/** The launch profiles of llama-server, in the `profiles` table, as the Nitro server stored them. */
export class ProfilesRepo extends Context.Service<
  ProfilesRepo,
  {
    /** Every profile, by name whatever the case. */
    readonly list: Effect.Effect<ReadonlyArray<Profile>>;
    readonly count: Effect.Effect<number>;
    readonly get: (id: number) => Effect.Effect<Profile, ProfileNotFound>;
    /** A new profile of source `ui`. */
    readonly create: (input: ProfileInput) => Effect.Effect<Profile, ProfileNameTaken>;
    /** Replaces every field of the input; `source` and `createdAt` stay, `updatedAt` moves. */
    readonly update: (change: {
      readonly id: number;
      readonly input: ProfileInput;
    }) => Effect.Effect<Profile, ProfileNotFound | ProfileNameTaken>;
    readonly remove: (id: number) => Effect.Effect<void, ProfileNotFound>;
    /** A copy under the first free name: `<name> (copy)`, `<name> (copy 2)`… A `llama-tui` source becomes `import`. */
    readonly duplicate: (id: number) => Effect.Effect<Profile, ProfileNotFound>;
    /** Creates each input in one transaction; one whose name exists is skipped with reason `already exists`. */
    readonly importMany: (batch: {
      readonly inputs: ReadonlyArray<ProfileInput>;
      readonly source: ProfileSource;
    }) => Effect.Effect<{
      readonly imported: ReadonlyArray<Profile>;
      readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
    }>;
  }
>()('@llama-webui/app/server/profiles/ProfilesRepo') {
  static readonly layer: Layer.Layer<ProfilesRepo, never, SqlClient.SqlClient> = Layer.effect(
    ProfilesRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Row,
        execute: () => sql`SELECT * FROM profiles ORDER BY name COLLATE NOCASE`,
      });
      const findById = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: Row,
        execute: (id) => sql`SELECT * FROM profiles WHERE id = ${id}`,
      });
      /** The id of the profile named exactly `name` (the comparison is case-sensitive, as the UNIQUE index). */
      const idOfName = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ id: Schema.Int }),
        execute: (name) => sql`SELECT id FROM profiles WHERE name = ${name}`,
      });

      /** The profile of `id`, or `ProfileNotFound`. */
      const byId = (id: number) =>
        findById(id).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(notFound()), onSome: Effect.succeed })),
        );

      /** The columns of an input, its lists as JSON. */
      const columns = Effect.fn('ProfilesRepo.columns')(function* (input: ProfileInput) {
        const args = yield* encodeArgs(input.args);
        const env = yield* encodeEnv(input.env);
        return {
          name: input.name,
          model_path: input.model,
          mmproj_path: input.mmproj ?? null,
          cwd: input.cwd ?? null,
          host: input.host ?? null,
          port: input.port ?? null,
          args_json: args,
          env_json: env,
        };
      });

      /** Stores `input` as a new row of `source`; its name is known to be free. */
      const insert = Effect.fn('ProfilesRepo.insert')(function* (input: ProfileInput, source: ProfileSource) {
        const now = yield* Clock.currentTimeMillis;
        const values = yield* columns(input);
        const rows = yield* sql`INSERT INTO profiles ${sql.insert({
          ...values,
          source,
          created_at: now,
          updated_at: now,
        })} RETURNING *`;
        const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
        return row === undefined ? yield* Effect.die('INSERT … RETURNING gave no row') : fromRow(row);
      });

      const list = findAll().pipe(Effect.map(Arr.map(fromRow)), Effect.orDie, Effect.withSpan('ProfilesRepo.list'));

      const count = sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM profiles`.pipe(
        Effect.map((rows) => Option.match(Arr.head(rows), { onNone: () => 0, onSome: (row) => row.n })),
        Effect.orDie,
        Effect.withSpan('ProfilesRepo.count'),
      );

      const get = Effect.fn('ProfilesRepo.get')(
        function* (id: number) {
          const row = yield* byId(id);
          return fromRow(row);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      // The name is checked in the transaction that writes: two creates of one name do not both pass.
      const create = Effect.fn('ProfilesRepo.create')(
        function* (input: ProfileInput) {
          const holder = yield* idOfName(input.name);
          if (Option.isSome(holder)) return yield* nameTaken(input.name);
          return yield* insert(input, 'ui');
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const update = Effect.fn('ProfilesRepo.update')(
        function* ({ id, input }: { readonly id: number; readonly input: ProfileInput }) {
          yield* byId(id);
          const holder = yield* idOfName(input.name);
          if (Option.isSome(holder) && holder.value.id !== id) return yield* nameTaken(input.name);
          const now = yield* Clock.currentTimeMillis;
          const values = yield* columns(input);
          yield* sql`UPDATE profiles SET ${sql.update({ ...values, updated_at: now })} WHERE id = ${id}`;
          const row = yield* byId(id);
          return fromRow(row);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const remove = Effect.fn('ProfilesRepo.remove')(
        function* (id: number) {
          yield* byId(id);
          yield* sql`DELETE FROM profiles WHERE id = ${id}`;
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const duplicate = Effect.fn('ProfilesRepo.duplicate')(
        function* (id: number) {
          const row = yield* byId(id);
          const source = fromRow(row);
          /** Whether the `n`th copy's name is taken. */
          const taken = (n: number) => Effect.map(idOfName(copyName(source.name, n)), Option.isSome);
          let n = 1;
          while (yield* taken(n)) n++;
          const { id: _id, source: from, createdAt: _c, updatedAt: _u, ...input } = source;
          return yield* insert({ ...input, name: copyName(source.name, n) }, from === 'llama-tui' ? 'import' : from);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const importMany = Effect.fn('ProfilesRepo.importMany')(
        function* ({
          inputs,
          source,
        }: {
          readonly inputs: ReadonlyArray<ProfileInput>;
          readonly source: ProfileSource;
        }) {
          const imported: Array<Profile> = [];
          const skipped: Array<{ readonly name: string; readonly reason: string }> = [];
          for (const input of inputs) {
            const holder = yield* idOfName(input.name);
            if (Option.isSome(holder)) skipped.push({ name: input.name, reason: 'already exists' });
            else {
              const profile = yield* insert(input, source);
              imported.push(profile);
            }
          }
          return { imported, skipped };
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      return ProfilesRepo.of({ list, count, get, create, update, remove, duplicate, importMany });
    }),
  );
}
