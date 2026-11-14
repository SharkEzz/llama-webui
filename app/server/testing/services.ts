import { NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { Flags } from '../flags/Flags.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { LogRing } from '../logs/LogRing.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { WsHub } from '../ws/WsHub.ts';

/**
 * The services the routes use, as `App.ts` builds them, on a new in-memory database and the Node platform (the flag
 * catalogue runs llama-server); and the answer to a request that does not decode, which `HttpApiTest.groups` needs as
 * the server's routes do.
 */
export const ServicesTest = Flags.layer.pipe(
  Layer.provideMerge(LogRing.layer),
  Layer.provideMerge(Layer.mergeAll(WsHub.layer, SettingsRepo.layer, ProfilesRepo.layer, RequestErrorsLive)),
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(Shutdown.layer),
  Layer.provideMerge(NodeServices.layer),
);
