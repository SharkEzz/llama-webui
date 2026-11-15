import type { DiskSpeed, Estimate } from '@llama-webui/shared';
import { Context, Effect, HashMap, Layer, type Option, Ref } from 'effect';

/** The last value kept for each model path. */
export interface Memo<A> {
  readonly get: (path: string) => Effect.Effect<Option.Option<A>>;
  readonly set: (path: string, value: A) => Effect.Effect<void>;
}

const makeMemo = <A>() =>
  Effect.map(
    Ref.make(HashMap.empty<string, A>()),
    (ref): Memo<A> => ({
      get: (path) => Effect.map(Ref.get(ref), HashMap.get(path)),
      set: (path, value) => Ref.update(ref, HashMap.set(path, value)),
    }),
  );

/**
 * The last estimate and the last disk measure of each model, for the checks (`/api/tuning/estimate` and
 * `/api/tuning/disk-speed` write what `/api/tuning/checks` reads). In memory, with the runtime: lost on a restart, which
 * is harmless.
 */
export class TuningMemo extends Context.Service<
  TuningMemo,
  { readonly estimates: Memo<Estimate>; readonly diskSpeeds: Memo<DiskSpeed> }
>()('@llama-webui/app/server/tuning/TuningMemo') {
  static readonly layer: Layer.Layer<TuningMemo> = Layer.effect(
    TuningMemo,
    Effect.all({ estimates: makeMemo<Estimate>(), diskSpeeds: makeMemo<DiskSpeed>() }).pipe(
      Effect.map((memos) => TuningMemo.of(memos)),
    ),
  );
}
