import { NodeServices } from '@effect/platform-node';
import { Array as Arr, Effect, Layer } from 'effect';
import { ChatRuns } from '../chat/ChatRuns.ts';
import { ConversationsRepo } from '../chat/ConversationsRepo.ts';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { Downloads } from '../downloads/Downloads.ts';
import { DownloadsRepo } from '../downloads/DownloadsRepo.ts';
import { Flags } from '../flags/Flags.ts';
import { PciIds } from '../hardware/PciIds.ts';
import { HfClient } from '../hf/HfClient.ts';
import { HfHttp } from '../hf/HfHttp.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { LogRing } from '../logs/LogRing.ts';
import { ActiveWrites } from '../models/ActiveWrites.ts';
import { GgufReader } from '../models/GgufReader.ts';
import { ModelCacheRepo } from '../models/ModelCacheRepo.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { Placement } from '../monitor/Placement.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';

/**
 * The services the routes use but the download queue, as `App.ts` builds them, on a new in-memory database and the
 * Node platform (the flag catalogue runs llama-server); and the answer to a request that does not decode, which `HttpApiTest.groups` needs as
 * the server's routes do. The monitor is the stub (no program, no tick); the placement follows the supervisor. The
 * supervisor polls `/health` every 50 ms, and sends SIGKILL 1 s after SIGTERM. The chat's replies are `ChatRuns.layer`'s:
 * building it marks every reply left `streaming` in the database `stopped` (`stopOrphans`) and registers the shutdown
 * step of the replies (saved `stopped` when `Shutdown.run` runs). The downloads that write a model are the
 * queued and running rows of the `downloads` table (`ActiveWrites.layer`, on `DownloadsRepo.layer`). No download
 * queue: a test of the queue builds its own on these services (a second queue on the same table would take its rows).
 * The Hub's client reads `HF_ENDPOINT` and the token from the configuration it is built with: a test sets them (a fake
 * Hub, no token of the user's).
 */
export const ServicesWithoutQueue = Layer.mergeAll(Monitor.layerStub, Placement.layer, ChatRuns.layer).pipe(
  Layer.provideMerge(Supervisor.layerWith({ killTimeout: '1 second', healthPoll: '50 millis' })),
  Layer.provideMerge(Flags.layer),
  Layer.provideMerge(
    Layer.mergeAll(LogRing.layer, LlamaHttp.layer, PciIds.layer, HfClient.layer.pipe(Layer.provideMerge(HfHttp.layer))),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      WsHub.layer,
      SettingsRepo.layer,
      ProfilesRepo.layer,
      ConversationsRepo.layer,
      ModelCacheRepo.layer,
      GgufReader.layer,
      ActiveWrites.layer.pipe(Layer.provideMerge(DownloadsRepo.layer)),
      RequestErrorsLive,
    ),
  ),
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(Shutdown.layer),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * `ServicesWithoutQueue` and the download queue on them, as the routes use it: `Downloads.layerWith` with no disk
 * space check (no `statfs` of the test's folders), its retries 10 ms apart, a stall after 5 s and every progress
 * published. It transfers from the configured Hub, and only starts on a request (the database is new: nothing to
 * resume).
 */
export const ServicesTest = Downloads.layerWith({
  freeBytes: () => Effect.succeed(null),
  retryDelays: Arr.replicate('10 millis', 5),
  stall: '5 seconds',
  liveEvery: '0 millis',
}).pipe(Layer.provideMerge(ServicesWithoutQueue));
