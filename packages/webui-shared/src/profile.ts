import { Array as Arr, Effect, Option, Predicate, Result, Schema, type SchemaAST, String as Str } from 'effect';
import { describeIssue, issuesOf } from './api/errors.ts';

/** Flags llama-webui passes itself; a profile cannot put them in `args`. */
export const RESERVED_FLAGS = [
  '--host',
  '--port',
  '--metrics',
  '--slots',
  '--props',
  '-m',
  '--model',
  '-mm',
  '--mmproj',
] as const;

/** The reserved flag `arg` passes (`--host=…` counts as `--host`), if any. */
export function reservedFlag(arg: string): string | undefined {
  const flag = Arr.headNonEmpty(Str.split(arg, '='));
  return Arr.findFirst(RESERVED_FLAGS, (reserved) => reserved === flag).pipe(Option.getOrUndefined);
}

export const reservedFlagMessage = (flag: string) => `${flag} is managed by llama-webui (use the profile fields)`;

/** The parse options of anything a person wrote: an unknown key is an error, every issue is reported. */
export const STRICT: SchemaAST.ParseOptions = { onExcessProperty: 'error', errors: 'all' };

/** A string a profile cannot do without: `required` when missing or not a string, `cannot be empty` when empty. */
const Required = Schema.String.annotate({ message: 'required' })
  .check(Schema.isMinLength(1, { message: 'cannot be empty' }))
  .annotateKey({ messageMissingKey: 'required' });

const Port = Schema.Number.annotate({ message: 'expected a number' }).check(
  Schema.isFinite({ message: 'expected a number' }),
  Schema.isInt({ message: 'expected an integer' }),
  Schema.isBetween({ minimum: 1, maximum: 65535 }, { message: 'port between 1 and 65535' }),
);

/** The arguments of llama-server: a reserved flag is an issue where it stands, one per offending argument. */
const Args = Schema.Array(Schema.String).check(
  Schema.makeFilter((args) =>
    Arr.flatMap(args, (arg, index) => {
      const flag = reservedFlag(arg);
      return flag === undefined ? [] : [{ path: [index], issue: reservedFlagMessage(flag) }];
    }),
  ),
);

/** A profile as a person writes it: the input of a create or an update, and the import and export format. */
export const ProfileInput = Schema.Struct({
  name: Required.annotate({ description: 'Unique profile name (case-sensitive).' }),
  model: Required.annotate({ description: 'GGUF model path (-m): absolute, ~/…, or relative to cwd.' }),
  mmproj: Schema.optionalKey(Schema.String.annotate({ description: 'Optional multimodal projector path (-mm).' })),
  cwd: Schema.optionalKey(Schema.String.annotate({ description: 'Working directory for llama-server (~ expanded).' })),
  host: Schema.optionalKey(
    Schema.String.annotate({ description: 'Listen address (--host); falls back to settings.host.' }),
  ),
  port: Schema.optionalKey(
    Port.annotate({ description: 'Listen port (--port, 1–65535); falls back to settings.port.' }),
  ),
  args: Args.annotate({
    description:
      'Extra llama-server CLI arguments, one token per item. Cannot contain reserved flags (--host, --port, --metrics, --slots, --props, -m, --model, -mm, --mmproj).',
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  env: Schema.Record(Schema.String, Schema.String)
    .annotate({ description: 'Environment variables merged on top of llama-webui and global settings.env.' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
}).annotate({
  identifier: 'ProfileInput',
  description: 'Strict input payload for creating, updating or importing a llama-server launch profile.',
  message: 'Expected object',
  messageUnexpectedKey: 'unknown key',
});
export type ProfileInput = typeof ProfileInput.Type;

/**
 * Where a profile comes from: made in the UI or imported from a file. `llama-tui` is the source of the rows the Nitro
 * server imported from the llama-tui config; nothing writes it any more, but stored rows still carry it.
 */
export const ProfileSource = Schema.Literals(['ui', 'import', 'llama-tui']).annotate({
  identifier: 'ProfileSource',
  description: 'Origin of a stored profile (ui, import, or legacy llama-tui).',
});
export type ProfileSource = typeof ProfileSource.Type;

/**
 * The fields of a profile as they are stored, without the rules of `ProfileInput`: a reply and an export carry what
 * the table holds, and a row written before a rule existed (an argument that became reserved since) must still be
 * listed, read, exported and copied. Only a create, an update and an import apply the rules.
 */
const storedFields = {
  name: Schema.String,
  model: Schema.String,
  mmproj: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
};

/** A stored profile in the import and export format: the fields of `ProfileInput`, as stored. */
export const ProfileExport = Schema.Struct(storedFields).annotate({
  identifier: 'ProfileExport',
  description: 'Portable JSON representation of a profile without id, source or timestamps.',
});
export type ProfileExport = typeof ProfileExport.Type;

/** A stored profile: its fields, its id, where it comes from, when it was created and last changed (epoch ms). */
export const Profile = Schema.Struct({
  id: Schema.Int,
  ...storedFields,
  source: ProfileSource,
  createdAt: Schema.Int.annotate({ description: 'Creation timestamp (epoch ms).' }),
  updatedAt: Schema.Int.annotate({ description: 'Last modification timestamp (epoch ms).' }),
}).annotate({
  identifier: 'Profile',
  description: 'A persisted llama-server launch profile.',
});
export type Profile = typeof Profile.Type;

export interface ProfileImport {
  profiles: ProfileInput[];
  rejected: { name: string; reason: string }[];
}

const decodeInput = Schema.decodeUnknownResult(ProfileInput, STRICT);

/** The items of an import body: an array, the `profiles` of a config, a single profile; nothing else holds one. */
const itemsOf = (raw: unknown): Option.Option<ReadonlyArray<unknown>> => {
  if (Arr.isArray(raw)) return Option.some(raw);
  if (!Predicate.isObject(raw)) return Option.none();
  if (Arr.isArray(raw.profiles)) return Option.some(raw.profiles);
  return 'name' in raw || 'model' in raw ? Option.some([raw]) : Option.none();
};

/** The name a rejection is filed under: the item's own when it has one. */
const nameOf = (item: unknown): string =>
  Predicate.isObject(item) && Predicate.isString(item.name) && Str.isNonEmpty(item.name) ? item.name : '(unnamed)';

/**
 * Reads an import JSON: an object with `profiles` (the export file, other keys ignored), an array of profiles or
 * a single profile. Each profile is validated on its own: valid ones are kept, the others explained (the first issue,
 * then its path), and a name the file already gave is refused.
 */
export function parseProfileImport(raw: unknown): ProfileImport {
  return Option.match(itemsOf(raw), {
    onNone: () => ({ profiles: [], rejected: [{ name: '(file)', reason: 'no profile found in this JSON' }] }),
    onSome: (items) => {
      const result: ProfileImport = { profiles: [], rejected: [] };
      const seen = new Set<string>();
      for (const item of items) {
        const name = nameOf(item);
        Result.match(decodeInput(item), {
          onFailure: (error) => {
            const first = Arr.head(issuesOf(error.issue));
            result.rejected.push({
              name,
              reason: Option.match(first, { onNone: () => 'invalid', onSome: describeIssue }),
            });
          },
          onSuccess: (profile) => {
            if (seen.has(profile.name)) result.rejected.push({ name, reason: 'duplicate name in the file' });
            else {
              seen.add(profile.name);
              result.profiles.push(profile);
            }
          },
        });
      }
      return result;
    },
  });
}
