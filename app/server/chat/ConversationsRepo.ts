import {
  type ChatMessage,
  type Conversation,
  ConversationNotFound,
  type ConversationPatch,
  type ConversationSummary,
  DEFAULT_TITLE,
  MessageStats,
  MessageStatus,
  StoredSampling,
} from '@llama-webui/shared';
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/sql';

/** The message a write names is not there: its conversation was deleted while a reply was being written. */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound, { readonly MessageNotFound: unique symbol }>()(
  'MessageNotFound',
  { message: Schema.String },
) {}

/**
 * The sampling column. `StoredSampling`'s `Int` keys were validated as integers by the Nitro server's zod: they are
 * not an input rule here (the input's limits are `Sampling`'s).
 */
const SamplingJson = Schema.fromJsonString(StoredSampling);
const StatsJson = Schema.fromJsonString(MessageStats);

/** A row of `conversations`, its sampling decoded. */
const ConversationRow = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  profile_id: Schema.NullOr(Schema.Int),
  model_path: Schema.NullOr(Schema.String),
  sampling_json: SamplingJson,
  system_prompt: Schema.String,
  thinking: Schema.Int,
  created_at: Schema.Int,
  updated_at: Schema.Int,
});

/** A row of `messages`; its stats stay text, decoded by `messageOf` (a stored value that does not decode is dropped). */
const MessageRow = Schema.Struct({
  id: Schema.Int,
  conversation_id: Schema.Int,
  role: Schema.Literals(['user', 'assistant']),
  content: Schema.String,
  reasoning: Schema.String,
  status: MessageStatus,
  error: Schema.NullOr(Schema.String),
  stats_json: Schema.NullOr(Schema.String),
  model_path: Schema.NullOr(Schema.String),
  created_at: Schema.Int,
});

const SummaryRow = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  updated_at: Schema.Int,
  model_path: Schema.NullOr(Schema.String),
  n: Schema.Int,
});

const conversationOf = (row: typeof ConversationRow.Type): Conversation => ({
  id: row.id,
  title: row.title,
  profileId: row.profile_id,
  modelPath: row.model_path,
  systemPrompt: row.system_prompt,
  sampling: row.sampling_json,
  thinking: row.thinking === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeStats = Schema.decodeUnknownEffect(StatsJson);

/**
 * The message of a row. A stats the schema refuses (the Nitro server wrote a NaN as `null`) reads as no stats: the row
 * survives and only its stats are lost.
 */
const messageOf = Effect.fn('ConversationsRepo.messageOf')(function* (row: typeof MessageRow.Type) {
  const stats =
    row.stats_json === null || row.stats_json === ''
      ? null
      : yield* decodeStats(row.stats_json).pipe(
          Effect.catchTag('SchemaError', (error) =>
            Effect.logWarning(`The stats of message ${row.id} do not decode: ${error.message}`).pipe(Effect.as(null)),
          ),
        );
  const message: ChatMessage = {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    status: row.status,
    error: row.error,
    stats,
    model: row.model_path,
    createdAt: row.created_at,
  };
  return message;
});

const encodeSampling = Schema.encodeEffect(SamplingJson);
const encodeStats = Schema.encodeEffect(StatsJson);

const conversationNotFound = () => ConversationNotFound.make({ message: 'Conversation not found' });
const messageNotFound = () => MessageNotFound.make({ message: 'Message not found' });

/** A message to add. */
export interface NewMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly status: MessageStatus;
  readonly model?: string | null;
}

/** What `updateMessage` changes: an omitted field is kept, `stats: null` clears the stats. */
export interface MessageUpdate {
  readonly content?: string;
  readonly reasoning?: string;
  readonly status?: MessageStatus;
  readonly error?: string | null;
  readonly stats?: MessageStats | null;
}

/** The chat's conversations and messages, in the tables the Nitro server wrote. */
export class ConversationsRepo extends Context.Service<
  ConversationsRepo,
  {
    /** Every conversation, the most recently updated first (then the highest id). */
    readonly list: Effect.Effect<ReadonlyArray<Omit<ConversationSummary, 'live'>>>;
    readonly get: (id: number) => Effect.Effect<Conversation, ConversationNotFound>;
    /** The messages of a conversation, by id. */
    readonly messages: (id: number) => Effect.Effect<ReadonlyArray<ChatMessage>>;
    /** A conversation titled `New conversation`, with no system prompt and no sampling, thinking on. */
    readonly create: (options: {
      readonly profileId: number | null;
      readonly modelPath: string | null;
    }) => Effect.Effect<Conversation>;
    /** Changes the given fields; `sampling` replaces the whole sampling; `updatedAt` moves even for `{}`. */
    readonly patch: (id: number, change: ConversationPatch) => Effect.Effect<Conversation, ConversationNotFound>;
    readonly remove: (id: number) => Effect.Effect<void, ConversationNotFound>;
    readonly setTitle: (id: number, title: string) => Effect.Effect<void>;
    /** The model the conversation now uses (`updatedAt` does not move). */
    readonly setModel: (id: number, profileId: number | null, modelPath: string | null) => Effect.Effect<void>;
    /** Adds a message at the end and bumps the conversation's `updatedAt`. */
    readonly addMessage: (id: number, message: NewMessage) => Effect.Effect<ChatMessage>;
    /** Changes a message and bumps its conversation's `updatedAt`; `MessageNotFound` when it is gone. */
    readonly updateMessage: (messageId: number, update: MessageUpdate) => Effect.Effect<ChatMessage, MessageNotFound>;
    /** Deletes the message and every later one of the conversation. */
    readonly deleteFrom: (id: number, messageId: number) => Effect.Effect<void>;
    /** After a hard stop: every reply left `streaming` becomes `stopped`; how many. */
    readonly stopOrphans: Effect.Effect<number>;
  }
>()('@llama-webui/app/server/chat/ConversationsRepo') {
  static readonly layer: Layer.Layer<ConversationsRepo, never, SqlClient.SqlClient> = Layer.effect(
    ConversationsRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findConversation = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: ConversationRow,
        execute: (id) => sql`SELECT * FROM conversations WHERE id = ${id}`,
      });
      const findMessage = SqlSchema.findOneOption({
        Request: Schema.Int,
        Result: MessageRow,
        execute: (id) => sql`SELECT * FROM messages WHERE id = ${id}`,
      });
      const findMessages = SqlSchema.findAll({
        Request: Schema.Int,
        Result: MessageRow,
        execute: (id) => sql`SELECT * FROM messages WHERE conversation_id = ${id} ORDER BY id`,
      });
      const findSummaries = SqlSchema.findAll({
        Request: Schema.Void,
        Result: SummaryRow,
        execute: () =>
          sql`SELECT c.id, c.title, c.updated_at, c.model_path,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n
            FROM conversations c ORDER BY c.updated_at DESC, c.id DESC`,
      });

      const byId = (id: number) =>
        findConversation(id).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(conversationNotFound()), onSome: Effect.succeed })),
          Effect.map(conversationOf),
        );

      const messageById = (id: number) =>
        findMessage(id).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(messageNotFound()), onSome: Effect.succeed })),
        );

      /** Moves the `updated_at` of a conversation to now. */
      const touch = Effect.fnUntraced(function* (id: number) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE conversations SET updated_at = ${now} WHERE id = ${id}`;
      });

      const list = findSummaries().pipe(
        Effect.map(
          Arr.map((row) => ({
            id: row.id,
            title: row.title,
            updatedAt: row.updated_at,
            modelPath: row.model_path,
            messageCount: row.n,
          })),
        ),
        Effect.orDie,
        Effect.withSpan('ConversationsRepo.list'),
      );

      const get = Effect.fn('ConversationsRepo.get')(
        function* (id: number) {
          return yield* byId(id);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const messages = Effect.fn('ConversationsRepo.messages')(
        function* (id: number) {
          const rows = yield* findMessages(id);
          return yield* Effect.forEach(rows, messageOf);
        },
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const create = Effect.fn('ConversationsRepo.create')(
        function* (options: { readonly profileId: number | null; readonly modelPath: string | null }) {
          const now = yield* Clock.currentTimeMillis;
          const sampling = yield* encodeSampling({});
          const rows = yield* sql`INSERT INTO conversations ${sql.insert({
            title: DEFAULT_TITLE,
            profile_id: options.profileId,
            model_path: options.modelPath,
            sampling_json: sampling,
            system_prompt: '',
            thinking: 1,
            created_at: now,
            updated_at: now,
          })} RETURNING id`;
          const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int })))(rows);
          if (row === undefined) return yield* Effect.die('INSERT … RETURNING gave no row');
          return yield* byId(row.id);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die, ConversationNotFound: Effect.die }),
      );

      const patch = Effect.fn('ConversationsRepo.patch')(
        function* (id: number, change: ConversationPatch) {
          const current = yield* byId(id);
          const now = yield* Clock.currentTimeMillis;
          const sampling = yield* encodeSampling(change.sampling ?? current.sampling);
          yield* sql`UPDATE conversations SET ${sql.update({
            title: change.title ?? current.title,
            system_prompt: change.systemPrompt ?? current.systemPrompt,
            sampling_json: sampling,
            thinking: (change.thinking ?? current.thinking) ? 1 : 0,
            updated_at: now,
          })} WHERE id = ${id}`;
          return yield* byId(id);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const remove = Effect.fn('ConversationsRepo.remove')(
        function* (id: number) {
          const rows = yield* sql`DELETE FROM conversations WHERE id = ${id} RETURNING id`;
          if (rows.length === 0) return yield* conversationNotFound();
        },
        Effect.catchTags({ SqlError: Effect.die }),
      );

      const setTitle = Effect.fn('ConversationsRepo.setTitle')(
        function* (id: number, title: string) {
          yield* sql`UPDATE conversations SET title = ${title} WHERE id = ${id}`;
        },
        Effect.catchTags({ SqlError: Effect.die }),
      );

      const setModel = Effect.fn('ConversationsRepo.setModel')(
        function* (id: number, profileId: number | null, modelPath: string | null) {
          yield* sql`UPDATE conversations SET profile_id = ${profileId}, model_path = ${modelPath} WHERE id = ${id}`;
        },
        Effect.catchTags({ SqlError: Effect.die }),
      );

      const addMessage = Effect.fn('ConversationsRepo.addMessage')(
        function* (id: number, message: NewMessage) {
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* sql`INSERT INTO messages ${sql.insert({
            conversation_id: id,
            role: message.role,
            content: message.content,
            status: message.status,
            model_path: message.model ?? null,
            created_at: now,
          })} RETURNING *`;
          const [row] = yield* Schema.decodeUnknownEffect(Schema.Array(MessageRow))(rows);
          if (row === undefined) return yield* Effect.die('INSERT … RETURNING gave no row');
          yield* touch(id);
          return yield* messageOf(row);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const updateMessage = Effect.fn('ConversationsRepo.updateMessage')(
        function* (messageId: number, update: MessageUpdate) {
          const current = yield* messageById(messageId);
          const stats =
            update.stats === undefined
              ? current.stats_json
              : update.stats === null
                ? null
                : yield* encodeStats(update.stats);
          yield* sql`UPDATE messages SET ${sql.update({
            content: update.content ?? current.content,
            reasoning: update.reasoning ?? current.reasoning,
            status: update.status ?? current.status,
            error: update.error === undefined ? current.error : update.error,
            stats_json: stats,
          })} WHERE id = ${messageId}`;
          yield* touch(current.conversation_id);
          const row = yield* messageById(messageId);
          return yield* messageOf(row);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
      );

      const deleteFrom = Effect.fn('ConversationsRepo.deleteFrom')(
        function* (id: number, messageId: number) {
          yield* sql`DELETE FROM messages WHERE conversation_id = ${id} AND id >= ${messageId}`;
          yield* touch(id);
        },
        sql.withTransaction,
        Effect.catchTags({ SqlError: Effect.die }),
      );

      const stopOrphans = sql`UPDATE messages SET status = 'stopped' WHERE status = 'streaming' RETURNING id`.pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
        Effect.withSpan('ConversationsRepo.stopOrphans'),
      );

      return ConversationsRepo.of({
        list,
        get,
        messages,
        create,
        patch,
        remove,
        setTitle,
        setModel,
        addMessage,
        updateMessage,
        deleteFrom,
        stopOrphans,
      });
    }),
  );
}
