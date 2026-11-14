// The data folder of a server a test runs as a process (the build, `vite dev`), made before it starts.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import * as Db from '../db/Db.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';

const setPort = (port: number) =>
  Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    yield* settings.patch({ port }).pipe(Effect.orDie);
  });

/**
 * The database of `dataDir` made with its `port` setting on `port` (a free one): the watch of a server started by
 * hand looks there every 2 s, and the default, 8080, is where the user's own llama-server may listen.
 */
export function seedWatchPort(dataDir: string, port: number): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const Seeded = SettingsRepo.layer.pipe(Layer.provideMerge(Db.layerAt(join(dataDir, 'llama-webui.sqlite'))));
  return Effect.runPromise(
    Layer.build(Seeded).pipe(
      Effect.flatMap((context) => Effect.provideContext(setPort(port), context)),
      Effect.scoped,
    ),
  );
}
