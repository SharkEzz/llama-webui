// Effect offers no home directory: the system's is `homedir()` of `node:os`, the Nitro server's fallback.
import { homedir } from 'node:os';
import { Config, Effect, Path, String as Str } from 'effect';

/** The home directory: `HOME` when it is set and not empty, else the system's. */
export const homeDir: Effect.Effect<string> = Config.String('HOME').pipe(
  Config.orElse(() => Config.succeed(homedir())),
  Effect.orDie,
  Effect.withSpan('Home.homeDir'),
);

/**
 * `~` and `~/…` expanded to the home directory; any other path as it is (`~user` included). The path is joined with the
 * `Path` of the platform, as the Nitro server joined it with `node:path`.
 */
export const expandHome = Effect.fn('Home.expandHome')(function* (path: string) {
  if (path !== '~' && !Str.startsWith('~/')(path)) return path;
  const home = yield* homeDir;
  const paths = yield* Path.Path;
  return path === '~' ? home : paths.join(home, Str.slice(2)(path));
});
