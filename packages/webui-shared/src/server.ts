import { Array as Arr, Effect, Option, Record as Rec, Schema } from 'effect';

/** The fields of a server llama-webui launched: its profile, its process, and the `--host` and port it listens on. */
const launched = {
  profile: Schema.String,
  profileId: Schema.Int,
  pid: Schema.Int,
  host: Schema.String,
  port: Schema.Int,
};

/** Live model-loading progress from llama-server's `/models/sse` (single-model mode, llama.cpp PR #32398). */
export const LoadProgress = Schema.Struct({
  /** Ordered stages of this load (e.g. `['text_model', 'spec_model', 'mmproj_model']`); empty when not yet reported. */
  stages: Schema.Array(Schema.String),
  /** Stage currently loading (`text_model`, `spec_model`, `mmproj_model`, or another name future builds add). */
  current: Schema.String,
  /** Fraction loaded within `current` in `[0, 1]`; null when the stage has no scalar progress yet. */
  value: Schema.NullOr(Schema.Finite),
});
export type LoadProgress = typeof LoadProgress.Type;

/** Live status of an external llama-server reported by `/models/sse`, when that server supports it. */
export const ExternalStatus = Schema.Literals(['loading', 'ready', 'sleeping']);
export type ExternalStatus = typeof ExternalStatus.Type;

/**
 * State of the supervised llama-server, told by its `kind`. `host` is the `--host` it listens on: the probes go there
 * (loopback for a wildcard address). An external server is reached on loopback.
 */
export const ServerState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('idle') }),
  Schema.Struct({
    kind: Schema.Literal('starting'),
    ...launched,
    since: Schema.Int,
    progress: Schema.optionalKey(LoadProgress),
    /**
     * Reloading the model after an idle sleep, not a launch: llama-server already answers and queues the requests it
     * receives until the model is back.
     */
    waking: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ kind: Schema.Literal('ready'), ...launched, since: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal('sleeping'), ...launched, since: Schema.Int }),
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
  Schema.Struct({
    kind: Schema.Literal('external'),
    pid: Schema.NullOr(Schema.Int),
    port: Schema.Int,
    status: Schema.optionalKey(ExternalStatus),
    progress: Schema.optionalKey(LoadProgress),
  }),
]);
export type ServerState = typeof ServerState.Type;

/** The state, the last launched command (shell-quoted, without the setpriv prefix) and the profile they belong to. */
export const ServerView = Schema.Struct({
  state: ServerState,
  command: Schema.NullOr(Schema.String),
  profileId: Schema.NullOr(Schema.Int),
});
export type ServerView = typeof ServerView.Type;

/** An optional key whose value of another type is dropped, as if llama-server had not sent it. */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

/** Any other key of llama-server's JSON, kept as it is. */
const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

/**
 * llama-server's `/props`: the fields the app reads, each absent when the build does not send it or sends it with
 * another type, and every other key as llama-server sent it. Not an object: a decoding error.
 */
export const ServerProps = Schema.StructWithRest(
  Schema.Struct({
    model_path: lenient(Schema.String),
    model_alias: lenient(Schema.String),
    model_ftype: lenient(Schema.String),
    total_slots: lenient(Schema.Int),
    build_info: lenient(Schema.String),
    /** Each input besides text and whether the model takes it (`vision`, `video`, `audio`). */
    modalities: lenient(Schema.Record(Schema.String, Schema.Boolean)),
    default_generation_settings: lenient(
      Schema.StructWithRest(
        Schema.Struct({
          n_ctx: lenient(Schema.Int),
          /** The default sampling settings (`temperature`, `top_k`…). */
          params: lenient(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        rest,
      ),
    ),
  }),
  rest,
);
export type ServerProps = typeof ServerProps.Type;

/** The `--host` of a state's server: null for an external one (reached on loopback) or no server. */
export const stateHost = (s: ServerState): string | null => ('host' in s ? s.host : null);

/** The profile of the server llama-webui runs (starting, ready, sleeping or stopping), else null. */
export const activeProfileId = (state: ServerState): number | null =>
  state.kind === 'starting' || state.kind === 'ready' || state.kind === 'sleeping' || state.kind === 'stopping'
    ? state.profileId
    : null;

/** Labels for the stages llama-server's `/models/sse` reports while loading. */
export const LOAD_STAGE_LABEL: Readonly<Record<string, string>> = {
  text_model: 'Model',
  spec_model: 'Draft model',
  mmproj_model: 'Projector',
};

/** Readable label for a loading stage (`text_model` → `Model`, unknown stages kept as is). */
export const loadStageLabel = (stage: string): string =>
  Option.getOrElse(Rec.get(LOAD_STAGE_LABEL, stage), () => stage);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Overall loading percentage in `[0, 100]` across the reported stages, or null when no scalar progress is known. */
export const loadProgressPct = (progress: LoadProgress): number | null => {
  const index = Arr.findFirstIndex(progress.stages, (s) => s === progress.current);
  if (Option.isSome(index) && Arr.isReadonlyArrayNonEmpty(progress.stages)) {
    const within = progress.value === null ? 0 : clamp01(progress.value);
    return ((index.value + within) / progress.stages.length) * 100;
  }
  return progress.value === null ? null : clamp01(progress.value) * 100;
};

/** Live loading progress attached to `state`, when starting or when an external server reports `loading`. */
export const stateLoadProgress = (state: ServerState | undefined): LoadProgress | null => {
  if (state === undefined) return null;
  if (state.kind === 'starting') return state.progress ?? null;
  if (state.kind === 'external' && state.status === 'loading') return state.progress ?? null;
  return null;
};

/** True when the server (managed or external) is loading a model. */
export const isServerLoading = (state: ServerState | undefined): boolean =>
  state !== undefined && (state.kind === 'starting' || (state.kind === 'external' && state.status === 'loading'));

/** True when the server (managed or external) is sleeping (`--sleep-idle-seconds`). */
export const isServerSleeping = (state: ServerState | undefined): boolean =>
  state !== undefined && (state.kind === 'sleeping' || (state.kind === 'external' && state.status === 'sleeping'));

/** A state whose server takes requests: `ready`, `sleeping` (a request wakes it), waking up, or external. */
export type ServingState = Extract<ServerState, { readonly kind: 'ready' | 'sleeping' | 'starting' | 'external' }>;

/**
 * True when llama-server takes requests: ready, sleeping or waking up (it queues them until its model is back), or
 * external. A launch that is still `starting` does not (llama-server answers 503 until it has loaded).
 */
export const servesRequests = (state: ServerState | undefined): state is ServingState =>
  state !== undefined &&
  (state.kind === 'ready' ||
    state.kind === 'sleeping' ||
    state.kind === 'external' ||
    (state.kind === 'starting' && state.waking === true));

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
