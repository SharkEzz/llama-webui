import { Schema } from 'effect';

/** The fields of a server llama-webui launched: its profile, its process, and the `--host` and port it listens on. */
const launched = {
  profile: Schema.String,
  profileId: Schema.Int,
  pid: Schema.Int,
  host: Schema.String,
  port: Schema.Int,
};

/**
 * State of the supervised llama-server, told by its `kind`. `host` is the `--host` it listens on: the probes go there
 * (loopback for a wildcard address). An external server is reached on loopback.
 */
export const ServerState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('idle') }),
  Schema.Struct({ kind: Schema.Literal('starting'), ...launched, since: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal('ready'), ...launched, since: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal('stopping'), ...launched }),
  Schema.Struct({
    kind: Schema.Literal('crashed'),
    profile: Schema.String,
    profileId: Schema.Int,
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
    at: Schema.Int,
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('external'), pid: Schema.NullOr(Schema.Int), port: Schema.Int }),
]);
export type ServerState = typeof ServerState.Type;

/** The state, the last launched command (shell-quoted, without the setpriv prefix) and the profile they belong to. */
export const ServerView = Schema.Struct({
  state: ServerState,
  command: Schema.NullOr(Schema.String),
  profileId: Schema.NullOr(Schema.Int),
});
export type ServerView = typeof ServerView.Type;

/** The `--host` of a state's server: null for an external one (reached on loopback) or no server. */
export const stateHost = (s: ServerState): string | null => ('host' in s ? s.host : null);

/** The profile of the server llama-webui runs (starting, ready or stopping), else null. */
export const activeProfileId = (state: ServerState): number | null =>
  state.kind === 'starting' || state.kind === 'ready' || state.kind === 'stopping' ? state.profileId : null;

/** The view of a state: the last command, and the profile of the state when it has one, else of the last command. */
export const serverView = ({
  state,
  last,
}: {
  readonly state: ServerState;
  readonly last: { readonly display: string; readonly profileId: number } | null;
}): ServerView => ({
  state,
  command: last === null ? null : last.display,
  profileId: 'profileId' in state ? state.profileId : last === null ? null : last.profileId,
});
