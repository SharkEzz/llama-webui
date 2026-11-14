// Effect has no parser of the .env format: parseEnv of node:util (nodeBuiltinImport does not flag node:util).
import { parseEnv } from 'node:util';
import { Effect, FileSystem, Option, type PlatformError, Predicate, Record, String as Str } from 'effect';
import { dual } from 'effect/Function';

/** Lets `.env` override the environment: `1` or `true`, set in the environment or in the file itself. */
const ENV_OVERRIDE = 'LLAMA_WEBUI_ENV_OVERRIDE';

const enabled = (value: string | undefined) =>
  value === '1' || (value !== undefined && Str.toLowerCase(value) === 'true');

export interface DotEnvOptions {
  /** The file wins over the environment (`--env-override`). */
  readonly override?: boolean;
}

/**
 * `.env` text applied to `env`: fills what is missing; with override (the option, or `LLAMA_WEBUI_ENV_OVERRIDE=1|true`
 * in `env` or in the file) the file wins. `parseEnv` of `node:util`: no `$VAR` expansion.
 */
export const applyDotEnv: {
  (text: string, options?: DotEnvOptions): (env: NodeJS.ProcessEnv) => void;
  (env: NodeJS.ProcessEnv, text: string, options?: DotEnvOptions): void;
} = dual(
  // Data first when the environment, an object, comes first; data last starts with the text.
  (args) => Predicate.isObject(args[0]),
  (env: NodeJS.ProcessEnv, text: string, options?: DotEnvOptions): void => {
    const vars = parseEnv(text);
    const override = options?.override === true || enabled(env[ENV_OVERRIDE] ?? vars[ENV_OVERRIDE]);
    for (const [key, value] of Record.toEntries(vars)) {
      if (override || env[key] === undefined) env[key] = value;
    }
  },
);

/** Applies `.env` of the current folder to the environment of the process; no file, nothing to do. */
export const loadDotEnv = Effect.fn('DotEnv.loadDotEnv')(function* (options: {
  readonly override: boolean;
}): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString('.env').pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
  );
  if (Option.isSome(text)) {
    // The one place that writes .env into the environment of the process.
    applyDotEnv(process.env, text.value, { override: options.override });
  }
});
