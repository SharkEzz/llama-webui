import { Layer } from 'effect';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { WsHub } from '../ws/WsHub.ts';

/** The services the routes use, as `App.ts` builds them, on a new in-memory database. */
export const ServicesTest = Layer.mergeAll(WsHub.layer, SettingsRepo.layer).pipe(
  Layer.provideMerge(AppInfo.layer),
  Layer.provideMerge(Db.layerAt(':memory:')),
);
