import type { HfTokenSource } from '@llama-webui/shared';
import { Array as Arr, Config, Effect, FileSystem, Option, String as Str } from 'effect';
import { homeDir } from '../config/Home.ts';
import { withoutTrailingSlash } from '../config/paths.ts';

/** The Hugging Face token and where it came from (`env`, `file`, or none). */
export interface HfToken {
  readonly token: string | null;
  readonly source: HfTokenSource;
}

const DEFAULT_ENDPOINT = 'https://huggingface.co';
const USER_AGENT = 'llama-webui';

/** A variable, trimmed: unset, empty or blank is none. */
const trimmed = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.filter(Option.map(value, Str.trim), Str.isNonEmpty)),
  );

/** The Hugging Face endpoint: `HF_ENDPOINT` (a mirror), else huggingface.co; without a trailing slash. */
export const hfEndpoint: Effect.Effect<string> = trimmed('HF_ENDPOINT').pipe(
  Config.map((endpoint) => withoutTrailingSlash(Option.getOrElse(endpoint, () => DEFAULT_ENDPOINT))),
  Effect.orDie,
  Effect.withSpan('token.hfEndpoint'),
);

/** `parts` under `dir`, as a path join puts them (a trailing slash of `dir` is not doubled). */
const under = (dir: string, ...parts: ReadonlyArray<string>): string =>
  Arr.join([withoutTrailingSlash(dir), ...parts], '/');

/**
 * Where `hf auth login` writes the token: `HF_TOKEN_PATH`, else `$HF_HOME/token`, else
 * `$XDG_CACHE_HOME/huggingface/token`, else `~/.cache/huggingface/token` (an empty variable counts as unset).
 */
export const hfTokenPath: Effect.Effect<string> = Effect.gen(function* () {
  const home = yield* homeDir;
  return yield* Config.String('HF_TOKEN_PATH').pipe(
    Config.orElse(() => Config.String('HF_HOME').pipe(Config.map((hfHome) => under(hfHome, 'token')))),
    Config.orElse(() =>
      Config.String('XDG_CACHE_HOME').pipe(Config.map((cache) => under(cache, 'huggingface', 'token'))),
    ),
    Config.orElse(() => Config.succeed(under(home, '.cache', 'huggingface', 'token'))),
  );
}).pipe(Effect.orDie, Effect.withSpan('token.hfTokenPath'));

/**
 * The Hugging Face token, by the rules of the `hf` CLI: `HF_TOKEN`, else the legacy `HUGGING_FACE_HUB_TOKEN` (a blank
 * one skipped), else the token file, each trimmed. Read on every call: an `hf auth login` done while the app runs is
 * picked up. A file that cannot be read is no token.
 */
export const hfToken: Effect.Effect<HfToken, never, FileSystem.FileSystem> = Effect.gen(function* () {
  const token = yield* Config.all([trimmed('HF_TOKEN'), trimmed('HUGGING_FACE_HUB_TOKEN')]).pipe(
    Config.map(([current, legacy]) => Option.orElse(current, () => legacy)),
  );
  if (Option.isSome(token)) return { token: token.value, source: 'env' } satisfies HfToken;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* hfTokenPath;
  const fromFile = yield* fs.readFileString(path).pipe(
    Effect.map(Str.trim),
    Effect.orElseSucceed(() => ''),
  );
  return Str.isNonEmpty(fromFile)
    ? ({ token: fromFile, source: 'file' } satisfies HfToken)
    : ({ token: null, source: null } satisfies HfToken);
}).pipe(Effect.orDie, Effect.withSpan('token.hfToken'));

/** The headers of every Hub request: the app's name, and the token when there is one. */
export const hubHeaders = (token: string | null): Record<string, string> =>
  token !== null && Str.isNonEmpty(token)
    ? { 'user-agent': USER_AGENT, authorization: `Bearer ${token}` }
    : { 'user-agent': USER_AGENT };
