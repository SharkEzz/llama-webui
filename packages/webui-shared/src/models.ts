import { Effect, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';

export const ModelKind = Schema.Literals(['model', 'mmproj']).annotate({
  identifier: 'ModelKind',
  description: 'Kind of GGUF file: main language model or multimodal projector (mmproj).',
});
export type ModelKind = typeof ModelKind.Type;

/**
 * Summary of a GGUF (header only), cached in the database. A reply carries what the `model_cache` table holds, so no
 * field has an input rule: what the file's metadata says is `Finite` (a GGUF may write a count as a float), what the
 * file system or the server counts is `Int`.
 */
export const ModelSummary = Schema.Struct({
  /** Absolute path of the file (the first shard of a split model). */
  path: Schema.String,
  /** Path relative to the models directory. */
  relPath: Schema.String,
  files: Schema.Array(Schema.String),
  fileBytes: Schema.Int,
  kind: ModelKind,
  arch: Schema.String,
  name: Schema.String,
  quant: Schema.String,
  params: Schema.Finite,
  blockCount: Schema.Finite,
  contextLength: Schema.Finite,
  embeddingLength: Schema.Finite,
  headCount: Schema.Finite,
  /** Maximum across layers. */
  headCountKv: Schema.Finite,
  expertCount: Schema.Finite,
  expertUsedCount: Schema.Finite,
  nextnLayers: Schema.Finite,
  recurrent: Schema.Boolean,
  slidingWindow: Schema.NullOr(Schema.Finite),
  hasChatTemplate: Schema.Boolean,
}).annotate({
  identifier: 'ModelSummary',
  description: 'Header metadata parsed from a GGUF file (or first shard of a split model) and cached in SQLite.',
});
export type ModelSummary = typeof ModelSummary.Type;

/** A GGUF of the models folder: its summary, or why it could not be read. */
export const ModelEntry = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ...ModelSummary.fields }),
  Schema.Struct({
    ok: Schema.Literal(false),
    path: Schema.String,
    relPath: Schema.String,
    files: Schema.Array(Schema.String),
    fileBytes: Schema.Int,
    error: Schema.String,
  }),
]).annotate({
  identifier: 'ModelEntry',
  description:
    'Result of scanning one GGUF entry: parsed ModelSummary when ok is true, or an error string when unreadable.',
});
export type ModelEntry = typeof ModelEntry.Type;

export const ModelList = Schema.Struct({
  /** Models directory, expanded (absolute). */
  dir: Schema.String,
  /** Models directory as entered in the settings (`~` included). */
  setting: Schema.String,
  home: Schema.String,
  scannedAt: Schema.Int,
  models: Schema.Array(ModelEntry),
}).annotate({
  identifier: 'ModelList',
  description: 'Result of scanning the configured models directory for GGUF files.',
});
export type ModelList = typeof ModelList.Type;

/** The bytes of a model's weights, by part. */
export const ModelWeights = Schema.Struct({
  embedBytes: Schema.Int,
  outputBytes: Schema.Int,
  layersBytes: Schema.Int,
  expertsBytes: Schema.Int,
  otherBytes: Schema.Int,
  totalBytes: Schema.Int,
}).annotate({
  identifier: 'ModelWeights',
  description: 'Byte breakdown of a GGUF model weights by tensor group.',
});
export type ModelWeights = typeof ModelWeights.Type;

/** A GGUF read whole (`GET /api/models/info`): its summary, its tensors' count and its weights. */
export const ModelDetail = Schema.Struct({
  ...ModelSummary.fields,
  tensorCount: Schema.Int,
  weights: ModelWeights,
}).annotate({
  identifier: 'ModelDetail',
  description: 'Detailed inspection of one GGUF file including tensor count and weight breakdown.',
});
export type ModelDetail = typeof ModelDetail.Type;

/** A profile that opens a model file, as its model or as its projector. */
export const ModelProfileUse = Schema.Struct({ id: Schema.Int, name: Schema.String, role: ModelKind }).annotate({
  identifier: 'ModelProfileUse',
  description: 'Reference from a saved profile to a GGUF file.',
});
export type ModelProfileUse = typeof ModelProfileUse.Type;

/** What deleting a model would remove, and why it is refused (`blocked`), from `GET /api/models/usage`. */
export const ModelUsage = Schema.Struct({
  path: Schema.String,
  /** Every file deleted (all the parts of a split model). */
  files: Schema.Array(Schema.String),
  fileBytes: Schema.Int,
  profiles: Schema.Array(ModelProfileUse),
  /** Why the model cannot be deleted now (the running server or a download uses it); null if it can. */
  blocked: Schema.NullOr(Schema.String),
}).annotate({
  identifier: 'ModelUsage',
  description: 'Files, referencing profiles and active-use blocker checked before deleting a GGUF model.',
});
export type ModelUsage = typeof ModelUsage.Type;

/** A deletion of a model (`DELETE /api/models`). */
export const ModelDelete = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1, { message: 'path required' })).pipe(
    Schema.annotateKey({ messageMissingKey: 'path required' }),
  ),
  /** Also delete the profiles that use the model. */
  deleteProfiles: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}).annotate({
  identifier: 'ModelDelete',
  description: 'Request payload to delete a GGUF model (all shards) and optionally its referencing profiles.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});
export type ModelDelete = typeof ModelDelete.Type;

/** What a deletion removed: the files, and the ids of the profiles. */
export const ModelDeleted = Schema.Struct({
  deletedFiles: Schema.Array(Schema.String),
  deletedProfiles: Schema.Array(Schema.Int),
}).annotate({
  identifier: 'ModelDeleted',
  description: 'Files removed from disk and profile IDs deleted by DELETE /api/models.',
});
export type ModelDeleted = typeof ModelDeleted.Type;

const expand = (p: string, home: string) =>
  p === '~' ? home : Str.startsWith('~/')(p) ? `${home}/${Str.slice(2)(p)}` : p;
const trimSlash = (p: string) => (p.length > 1 ? Str.replace(/\/+$/, '')(p) : p);

/** `abs` relative to `dir` if inside it, otherwise null. */
function relativeTo(abs: string, dir: string): string | null {
  const d = trimSlash(dir);
  return Str.startsWith(`${d}/`)(abs) ? Str.slice(d.length + 1)(abs) : null;
}

/** Where a profile's model path is written from: its working directory (if any), the models directory, the home. */
export interface ModelPathContext {
  readonly cwd?: string | undefined;
  readonly modelsDir: string;
  readonly home: string;
}

/**
 * Model path to write into a profile: without a working directory, the models directory is used (as entered) and the
 * path is relative to it; under the working directory, relative; elsewhere, absolute.
 */
export const profileModelPath: {
  (o: ModelPathContext): (abs: string) => { cwd?: string; model: string };
  (abs: string, o: ModelPathContext): { cwd?: string; model: string };
} = dual(2, (abs: string, o: ModelPathContext): { cwd?: string; model: string } => {
  const given = Str.trim(o.cwd ?? '');
  const cwd = Str.isNonEmpty(given) ? given : o.modelsDir;
  const rel = relativeTo(abs, expand(cwd, o.home));
  return { cwd, model: rel ?? abs };
});
