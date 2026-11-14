import { Effect, Option, Path } from 'effect';
import { homeDir } from '../config/Home.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { profilePaths } from '../supervisor/command.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';

/** The llama-server a reply is asked of. */
export interface ChatTarget {
  /** The `--host` of the server; null for an external server, reached on loopback. */
  readonly host: string | null;
  readonly port: number;
  /** The profile it runs, null for an external server. */
  readonly profileId: number | null;
  /** The model it opened (the profile's, as llama-server resolves it), null for an external server. */
  readonly modelPath: string | null;
}

/**
 * The llama-server that answers the chat: the managed one once it is `ready` (its `--host`, its port, its profile and
 * that profile's model, null when the profile is gone), an external one on loopback at its port (no profile, no
 * model), else none.
 */
export const chatTarget: Effect.Effect<
  Option.Option<ChatTarget>,
  never,
  Supervisor | ProfilesRepo | Path.Path
> = Effect.gen(function* () {
  const supervisor = yield* Supervisor;
  const state = yield* supervisor.state;
  if (state.kind === 'external') {
    return Option.some({ host: null, port: state.port, profileId: null, modelPath: null });
  }
  if (state.kind !== 'ready') return Option.none();
  const profiles = yield* ProfilesRepo;
  const path = yield* Path.Path;
  const home = yield* homeDir;
  const modelPath = yield* profiles.get(state.profileId).pipe(
    Effect.map((profile) => profilePaths({ profile, home, cwd: path.resolve('.'), path }).model),
    Effect.catchTag('ProfileNotFound', () => Effect.succeed(null)),
  );
  return Option.some({ host: state.host, port: state.port, profileId: state.profileId, modelPath });
}).pipe(Effect.withSpan('chat.chatTarget'));
