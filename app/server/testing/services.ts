import { Layer } from 'effect';
import { AppInfo } from '../config/AppInfo.ts';
import * as Db from '../db/Db.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';

/** The services the routes use, as `App.ts` builds them, on a new in-memory database. */
export const ServicesTest = Layer.mergeAll(AppInfo.layer, SettingsRepo.layer).pipe(
  Layer.provideMerge(Db.layerAt(':memory:')),
);
