import { assert, describe, it } from '@effect/vitest';
import type { ProfileInput } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, String as Str } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import * as Db from '../db/Db.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';

/** A repository on a new in-memory database, with its client for what the test stores itself. */
const Fresh = ProfilesRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:')));

/** `test` on its own new database. */
const fresh = <A, E>(test: Effect.Effect<A, E, ProfilesRepo | SqlClient.SqlClient>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** The smallest valid input. */
const input = (name: string, more: Partial<ProfileInput> = {}): ProfileInput => ({
  name,
  model: '/models/m.gguf',
  args: [],
  env: {},
  ...more,
});

describe('ProfilesRepo', () => {
  it.effect('create stores a profile of source ui, with only the optional fields it was given', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const created = yield* repo.create(input('A', { port: 8081, args: ['-c', '4096'], env: { X: '1' } }));
        assert.deepStrictEqual(created, {
          id: created.id,
          name: 'A',
          model: '/models/m.gguf',
          port: 8081,
          args: ['-c', '4096'],
          env: { X: '1' },
          source: 'ui',
          createdAt: created.createdAt,
          updatedAt: created.createdAt,
        });
        assert.isFalse('mmproj' in created);
        assert.isFalse('cwd' in created);
        assert.isFalse('host' in created);
        const read = yield* repo.get(created.id);
        assert.deepStrictEqual(read, created);
      }),
    ),
  );

  it.effect('create and update refuse a name another profile has, quoting it as written', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const odd = 'say "hi" / ünï 🦙';
        yield* repo.create(input('A'));
        const oddOne = yield* repo.create(input(odd));
        const taken = yield* Effect.flip(repo.create(input('A')));
        assert.strictEqual(taken._tag, 'ProfileNameTaken');
        assert.strictEqual(taken.message, 'A profile named “A” already exists');
        const b = yield* repo.create(input('B'));
        const renamed = yield* Effect.flip(repo.update({ id: b.id, input: input(odd) }));
        assert.strictEqual(renamed._tag, 'ProfileNameTaken');
        assert.strictEqual(renamed.message, `A profile named “${odd}” already exists`);
        const kept = yield* repo.update({ id: oddOne.id, input: input(odd, { port: 9000 }) });
        assert.strictEqual(kept.port, 9000);
        const count = yield* repo.count;
        assert.strictEqual(count, 3);
      }),
    ),
  );

  it.effect('update replaces every field, keeps source and createdAt, moves updatedAt', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const created = yield* repo.create(
          input('A', { mmproj: '/models/p.gguf', port: 8081, args: ['-c', '1'], env: { X: '1' } }),
        );
        yield* TestClock.adjust('1 second');
        const updated = yield* repo.update({
          id: created.id,
          input: { name: 'A2', model: '/models/n.gguf', args: [], env: {} },
        });
        assert.deepStrictEqual(updated, {
          id: created.id,
          name: 'A2',
          model: '/models/n.gguf',
          args: [],
          env: {},
          source: 'ui',
          createdAt: created.createdAt,
          updatedAt: created.createdAt + 1000,
        });
      }),
    ),
  );

  it.effect('get, update, remove and duplicate of an id that is not there fail with ProfileNotFound', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const failures = yield* Effect.all([
          Effect.flip(repo.get(999)),
          Effect.flip(repo.update({ id: 999, input: input('A') })),
          Effect.flip(repo.remove(999)),
          Effect.flip(repo.duplicate(999)),
        ]);
        for (const failure of failures) {
          assert.strictEqual(failure._tag, 'ProfileNotFound');
          assert.strictEqual(failure.message, 'Profile not found');
        }
        const count = yield* repo.count;
        assert.strictEqual(count, 0);
      }),
    ),
  );

  it.effect('list orders by name whatever the case', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        for (const name of ['b', 'A', 'C', 'a']) yield* repo.create(input(name));
        const list = yield* repo.list;
        assert.deepStrictEqual(
          Arr.map(list, (profile) => Str.toLowerCase(profile.name)),
          ['a', 'a', 'b', 'c'],
        );
      }),
    ),
  );

  it.effect('duplicate numbers its copies and turns a llama-tui source into import', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const a = yield* repo.create(input('A', { port: 8081 }));
        const first = yield* repo.duplicate(a.id);
        const second = yield* repo.duplicate(a.id);
        const third = yield* repo.duplicate(a.id);
        assert.deepStrictEqual(
          Arr.map([first, second, third], (copy) => copy.name),
          ['A (copy)', 'A (copy 2)', 'A (copy 3)'],
        );
        assert.strictEqual(first.port, 8081);
        assert.strictEqual(first.source, 'ui');
        assert.notStrictEqual(first.id, a.id);
        const { imported } = yield* repo.importMany({ inputs: [input('T')], source: 'llama-tui' });
        const [tui] = imported;
        assert.isDefined(tui);
        if (tui === undefined) return;
        const copy = yield* repo.duplicate(tui.id);
        assert.strictEqual(copy.source, 'import');
        assert.strictEqual(copy.name, 'T (copy)');
      }),
    ),
  );

  it.effect('importMany creates in one transaction and skips a name that exists', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        yield* repo.create(input('A'));
        const result = yield* repo.importMany({ inputs: [input('A'), input('B')], source: 'import' });
        assert.deepStrictEqual(
          Arr.map(result.imported, (profile) => [profile.name, profile.source]),
          [['B', 'import']],
        );
        assert.deepStrictEqual(result.skipped, [{ name: 'A', reason: 'already exists' }]);
        const count = yield* repo.count;
        assert.strictEqual(count, 2);
      }),
    ),
  );

  it.effect('removing a profile keeps its conversations, bench runs and sweeps, without a profile', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ProfilesRepo;
        const sql = yield* SqlClient.SqlClient;
        const profile = yield* repo.create(input('A'));
        const id = profile.id;
        yield* sql`INSERT INTO conversations(title, profile_id, sampling_json, system_prompt, created_at, updated_at)
          VALUES ('c', ${id}, '{}', '', 0, 0)`;
        yield* sql`INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command, hardware_json,
          vram_mib_json, created_at) VALUES ('bench', 'done', 'm', ${id}, '{}', 'x', '{}', '[]', 0)`;
        yield* sql`INSERT INTO sweeps(name, status, model_path, profile_id, spec_json, created_at)
          VALUES ('s', 'done', 'm', ${id}, '{}', 0)`;
        yield* repo.remove(id);
        const rows = yield* sql<{ readonly profile_id: number | null }>`
          SELECT profile_id FROM conversations UNION ALL SELECT profile_id FROM bench_runs
          UNION ALL SELECT profile_id FROM sweeps`;
        assert.deepStrictEqual(rows, [{ profile_id: null }, { profile_id: null }, { profile_id: null }]);
        const count = yield* repo.count;
        assert.strictEqual(count, 0);
      }),
    ),
  );
});
