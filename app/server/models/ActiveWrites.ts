import type { DownloadItem } from '@llama-webui/shared';
import { Context, Effect, Layer } from 'effect';

/** The downloads that are writing files now (queued or running): a model one of them writes is not deleted. */
export class ActiveWrites extends Context.Service<
  ActiveWrites,
  {
    /** The queued and running items of the download queue. */
    readonly active: Effect.Effect<ReadonlyArray<DownloadItem>>;
  }
>()('@llama-webui/app/server/models/ActiveWrites') {
  /** No download queue: nothing is ever written. */
  static readonly layerNone: Layer.Layer<ActiveWrites> = Layer.succeed(
    ActiveWrites,
    ActiveWrites.of({ active: Effect.succeed([]) }),
  );
}
