import type { DownloadItem } from '@llama-webui/shared';
import { Context, Effect, Layer } from 'effect';
import { DownloadsRepo } from '../downloads/DownloadsRepo.ts';

/** The downloads that are writing files now (queued or running): a model one of them writes is not deleted. */
export class ActiveWrites extends Context.Service<
  ActiveWrites,
  {
    /** The queued and running items of the download queue. */
    readonly active: Effect.Effect<ReadonlyArray<DownloadItem>>;
  }
>()('@llama-webui/app/server/models/ActiveWrites') {
  /** The queued and running items of the `downloads` table. */
  static readonly layer: Layer.Layer<ActiveWrites, never, DownloadsRepo> = Layer.effect(
    ActiveWrites,
    Effect.gen(function* () {
      const repo = yield* DownloadsRepo;
      return ActiveWrites.of({ active: repo.active });
    }),
  );
}
