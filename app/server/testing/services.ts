import { Layer } from 'effect';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { RequestErrorsLive } from '../http/RequestErrors.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { Shutdown } from '../runtime/Shutdown.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { WsHub } from '../ws/WsHub.ts';

/**
 * The services the routes use, as `App.ts` builds them, on a new in-memory database; and the answer to a request that
 * does not decode, which `HttpApiTest.groups` needs as the server's routes do.
 */
export const ServicesTest = Layer.mergeAll(WsHub.layer, SettingsRepo.layer, ProfilesRepo.layer, RequestErrorsLive).pipe(
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
  Layer.provideMerge(Shutdown.layer),
);
