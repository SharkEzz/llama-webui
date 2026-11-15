import { assert, describe, it } from '@effect/vitest';
import { ConversationPatch, type MessageStats } from '@llama-webui/shared';
import { Array as Arr, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import * as Db from '../db/Db.ts';
import { ConversationsRepo } from './ConversationsRepo.ts';

/** A repository on a new in-memory database, with its client for what the test stores itself. */
const Fresh = ConversationsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(':memory:')));

/** `test` on its own new database. */
const fresh = <A, E>(test: Effect.Effect<A, E, ConversationsRepo | SqlClient.SqlClient>) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** A patch as the endpoint decodes it (the title is trimmed by its schema). */
const decodePatch = Schema.decodeUnknownEffect(ConversationPatch);
const patched = (repo: ConversationsRepo['Service'], id: number, raw: unknown) =>
  decodePatch(raw).pipe(Effect.flatMap((change) => repo.patch(id, change)));

const none = { profileId: null, modelPath: null };

const stats: MessageStats = {
  ttftMs: 120,
  promptTokens: 10,
  cachedTokens: 4,
  genTokens: 50,
  ppTps: 800.5,
  tgTps: 42.25,
  draftN: null,
  draftAccepted: null,
  durationMs: 1500,
};

describe('ConversationsRepo', () => {
  it.effect('create, get and list order by updated_at then id', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const a = yield* repo.create({ profileId: null, modelPath: '/m/a.gguf' });
        assert.deepStrictEqual(a, {
          id: a.id,
          title: 'New conversation',
          profileId: null,
          modelPath: '/m/a.gguf',
          systemPrompt: '',
          sampling: {},
          thinking: true,
          createdAt: 0,
          updatedAt: 0,
        });
        const b = yield* repo.create(none);
        yield* TestClock.adjust('1 second');
        const c = yield* repo.create(none);
        const read = yield* repo.get(c.id);
        assert.deepStrictEqual(read, c);
        const list = yield* repo.list;
        assert.deepStrictEqual(
          Arr.map(list, (row) => row.id),
          [c.id, b.id, a.id],
        );
        assert.deepStrictEqual(list[2], {
          id: a.id,
          title: 'New conversation',
          updatedAt: 0,
          modelPath: '/m/a.gguf',
          messageCount: 0,
        });
        const missing = yield* Effect.flip(repo.get(999));
        assert.strictEqual(missing._tag, 'ConversationNotFound');
        assert.strictEqual(missing.message, 'Conversation not found');
      }),
    ),
  );

  it.effect(
    'patch stores the fields, trims the title, replaces the sampling whole and bumps updated_at even for {}',
    () =>
      fresh(
        Effect.gen(function* () {
          const repo = yield* ConversationsRepo;
          const created = yield* repo.create(none);
          yield* TestClock.adjust('1 second');
          const first = yield* patched(repo, created.id, {
            title: '  Hello  ',
            systemPrompt: 'Be brief',
            sampling: { temperature: 0.5, top_k: 40, seed: 7 },
            thinking: false,
          });
          assert.deepStrictEqual(first, {
            ...created,
            title: 'Hello',
            systemPrompt: 'Be brief',
            sampling: { temperature: 0.5, top_k: 40, seed: 7 },
            thinking: false,
            updatedAt: 1000,
          });
          yield* TestClock.adjust('1 second');
          const second = yield* patched(repo, created.id, { sampling: { top_p: 0.9 } });
          assert.deepStrictEqual(second.sampling, { top_p: 0.9 });
          assert.strictEqual(second.title, 'Hello');
          assert.strictEqual(second.thinking, false);
          assert.strictEqual(second.updatedAt, 2000);
          yield* TestClock.adjust('1 second');
          const third = yield* patched(repo, created.id, {});
          assert.deepStrictEqual(third, { ...second, updatedAt: 3000 });
          const missing = yield* Effect.flip(patched(repo, 999, {}));
          assert.strictEqual(missing._tag, 'ConversationNotFound');
        }),
      ),
  );

  it.effect('setModel does not bump updated_at', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const created = yield* repo.create(none);
        yield* TestClock.adjust('1 second');
        yield* repo.setModel(created.id, null, '/m/b.gguf');
        yield* repo.setTitle(created.id, 'Renamed');
        const read = yield* repo.get(created.id);
        assert.deepStrictEqual(read, { ...created, modelPath: '/m/b.gguf', title: 'Renamed' });
      }),
    ),
  );

  it.effect('addMessage bumps the conversation and messages come back by id', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const created = yield* repo.create(none);
        yield* TestClock.adjust('1 second');
        const user = yield* repo.addMessage(created.id, { role: 'user', content: 'hi', status: 'done' });
        yield* TestClock.adjust('1 second');
        const reply = yield* repo.addMessage(created.id, {
          role: 'assistant',
          content: '',
          status: 'streaming',
          model: '/m/a.gguf',
        });
        assert.deepStrictEqual(user, {
          id: user.id,
          conversationId: created.id,
          role: 'user',
          content: 'hi',
          reasoning: '',
          status: 'done',
          error: null,
          stats: null,
          model: null,
          createdAt: 1000,
        });
        assert.strictEqual(reply.model, '/m/a.gguf');
        assert.strictEqual(reply.createdAt, 2000);
        const messages = yield* repo.messages(created.id);
        assert.deepStrictEqual(messages, [user, reply]);
        const conversation = yield* repo.get(created.id);
        assert.strictEqual(conversation.updatedAt, 2000);
        const list = yield* repo.list;
        assert.strictEqual(list[0]?.messageCount, 2);
        yield* TestClock.adjust('1 second');
        const updated = yield* repo.updateMessage(reply.id, {
          content: 'hello',
          reasoning: 'thinking',
          status: 'done',
          stats,
        });
        assert.deepStrictEqual(updated, {
          ...reply,
          content: 'hello',
          reasoning: 'thinking',
          status: 'done',
          stats,
        });
        const kept = yield* repo.updateMessage(reply.id, { error: 'boom' });
        assert.deepStrictEqual(kept, { ...updated, error: 'boom' });
        const cleared = yield* repo.updateMessage(reply.id, { stats: null, error: null });
        assert.deepStrictEqual(cleared, { ...updated, stats: null });
        const bumped = yield* repo.get(created.id);
        assert.strictEqual(bumped.updatedAt, 3000);
      }),
    ),
  );

  it.effect("updateMessage of a deleted conversation's message fails with MessageNotFound", () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const created = yield* repo.create(none);
        const reply = yield* repo.addMessage(created.id, { role: 'assistant', content: '', status: 'streaming' });
        yield* repo.remove(created.id);
        const failure = yield* Effect.flip(repo.updateMessage(reply.id, { content: 'late' }));
        assert.strictEqual(failure._tag, 'MessageNotFound');
      }),
    ),
  );

  it.effect('deleteFrom removes the message and every later one', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const a = yield* repo.create(none);
        const other = yield* repo.create(none);
        const m1 = yield* repo.addMessage(a.id, { role: 'user', content: '1', status: 'done' });
        const m2 = yield* repo.addMessage(a.id, { role: 'assistant', content: '2', status: 'done' });
        yield* repo.addMessage(a.id, { role: 'user', content: '3', status: 'done' });
        const o1 = yield* repo.addMessage(other.id, { role: 'user', content: 'o', status: 'done' });
        yield* repo.deleteFrom(a.id, m2.id);
        const left = yield* repo.messages(a.id);
        assert.deepStrictEqual(left, [m1]);
        const untouched = yield* repo.messages(other.id);
        assert.deepStrictEqual(untouched, [o1]);
      }),
    ),
  );

  it.effect('remove deletes the messages by cascade', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const sql = yield* SqlClient.SqlClient;
        const created = yield* repo.create(none);
        yield* repo.addMessage(created.id, { role: 'user', content: 'x', status: 'done' });
        yield* repo.remove(created.id);
        const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM messages`;
        assert.deepStrictEqual(rows, [{ n: 0 }]);
        const again = yield* Effect.flip(repo.remove(created.id));
        assert.strictEqual(again._tag, 'ConversationNotFound');
      }),
    ),
  );

  it.effect('stopOrphans marks every streaming message stopped and counts them', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const created = yield* repo.create(none);
        const done = yield* repo.addMessage(created.id, { role: 'user', content: 'x', status: 'done' });
        const one = yield* repo.addMessage(created.id, { role: 'assistant', content: '', status: 'streaming' });
        const two = yield* repo.addMessage(created.id, { role: 'assistant', content: '', status: 'streaming' });
        const count = yield* repo.stopOrphans;
        assert.strictEqual(count, 2);
        const messages = yield* repo.messages(created.id);
        assert.deepStrictEqual(
          Arr.map(messages, (message) => [message.id, message.status]),
          [
            [done.id, 'done'],
            [one.id, 'stopped'],
            [two.id, 'stopped'],
          ],
        );
        const again = yield* repo.stopOrphans;
        assert.strictEqual(again, 0);
      }),
    ),
  );

  it.effect('a row written by the Nitro server reads back', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO conversations(id, title, profile_id, model_path, sampling_json, system_prompt, thinking,
          created_at, updated_at) VALUES (1, 'Old', NULL, '/m/a.gguf', '{}', '', 1, 5, 6)`;
        yield* sql`INSERT INTO messages(id, conversation_id, role, content, reasoning, status, error, stats_json,
          model_path, created_at) VALUES (1, 1, 'assistant', 'hi', 'hm', 'done', NULL,
          '{"ttftMs":120,"promptTokens":10,"cachedTokens":4,"genTokens":50,"ppTps":800.5,"tgTps":42.25,"draftN":null,"draftAccepted":null,"durationMs":1500}',
          '/m/a.gguf', 7)`;
        const conversation = yield* repo.get(1);
        assert.deepStrictEqual(conversation, {
          id: 1,
          title: 'Old',
          profileId: null,
          modelPath: '/m/a.gguf',
          systemPrompt: '',
          sampling: {},
          thinking: true,
          createdAt: 5,
          updatedAt: 6,
        });
        const messages = yield* repo.messages(1);
        assert.deepStrictEqual(messages, [
          {
            id: 1,
            conversationId: 1,
            role: 'assistant',
            content: 'hi',
            reasoning: 'hm',
            status: 'done',
            error: null,
            stats,
            model: '/m/a.gguf',
            createdAt: 7,
          },
        ]);
      }),
    ),
  );

  it.effect('a stored message whose stats do not decode reads with no stats', () =>
    fresh(
      Effect.gen(function* () {
        const repo = yield* ConversationsRepo;
        const sql = yield* SqlClient.SqlClient;
        const created = yield* repo.create(none);
        yield* sql`INSERT INTO messages(conversation_id, role, content, status, stats_json, created_at)
          VALUES (${created.id}, 'assistant', 'hi', 'done',
          '{"ttftMs":null,"promptTokens":1,"cachedTokens":0,"genTokens":2,"ppTps":null,"tgTps":3,"draftN":null,"draftAccepted":null,"durationMs":4}',
          0)`;
        const messages = yield* repo.messages(created.id);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0]?.content, 'hi');
        assert.strictEqual(messages[0]?.stats, null);
      }),
    ),
  );
});
