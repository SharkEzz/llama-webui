import { NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { Flags } from '../flags/Flags.ts';
import { PciIds } from '../hardware/PciIds.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { LlamaHttp } from '../llama/LlamaHttp.ts';
import { LogRing } from '../logs/LogRing.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { Placement } from '../monitor/Placement.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { WsHub } from '../ws/WsHub.ts';

/**
 * The services the routes use, as `App.ts` builds them, on a new in-memory database and the Node platform (the flag
 * catalogue runs llama-server); and the answer to a request that does not decode, which `HttpApiTest.groups` needs as
 * the server's routes do. The monitor is the stub (no program, no tick); the placement follows the supervisor. The
 * supervisor polls `/health` every 50 ms, and sends SIGKILL 1 s after SIGTERM.
 */
export const ServicesTest = Layer.merge(Monitor.layerStub, Placement.layer).pipe(
  Layer.provideMerge(Supervisor.layerWith({ killTimeout: '1 second', healthPoll: '50 millis' })),
  Layer.provideMerge(Flags.layer),
  Layer.provideMerge(Layer.mergeAll(LogRing.layer, LlamaHttp.layer, PciIds.layer)),
  Layer.provideMerge(Layer.mergeAll(WsHub.layer, SettingsRepo.layer, ProfilesRepo.layer, RequestErrorsLive)),
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(Shutdown.layer),
  Layer.provideMerge(NodeServices.layer),
);
