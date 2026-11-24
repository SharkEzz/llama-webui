import { servesRequests } from '@llama-webui/shared';
import { Effect, Option, type Path } from 'effect';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { resolveProfilePaths } from '../supervisor/command.ts';
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
 * The llama-server that answers the chat: the managed one once it is `ready`, `sleeping` (sending a request wakes
 * llama-server automatically) or waking up (llama-server queues the request until its model is back), an external one
 * on loopback at its port (no profile, no model), else none.
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
  if (!servesRequests(state)) return Option.none();
  const profiles = yield* ProfilesRepo;
  const modelPath = yield* profiles.get(state.profileId).pipe(
    Effect.flatMap((profile) => Effect.map(resolveProfilePaths(profile), (p) => p.model)),
    Effect.catchTag('ProfileNotFound', () => Effect.succeed(null)),
  );
  return Option.some({ host: state.host, port: state.port, profileId: state.profileId, modelPath });
}).pipe(Effect.withSpan('chat.chatTarget'));
