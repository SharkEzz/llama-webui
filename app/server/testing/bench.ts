import type { BenchHardware, BenchSpec, SweepSpec } from '@llama-webui/shared';
import { Effect, Layer } from 'effect';
import type { SqlClient } from 'effect/sql';
import { BenchRunsRepo } from '../bench/BenchRunsRepo.ts';
import { SweepsRepo } from '../bench/SweepsRepo.ts';
import * as Db from '../db/Db.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';

/** The two repositories and the profiles on a new in-memory database, with its client. */
const Fresh = Layer.mergeAll(BenchRunsRepo.layer, SweepsRepo.layer, ProfilesRepo.layer).pipe(
  Layer.provideMerge(Db.layerAt(':memory:')),
);

/** `test` on its own new database. */
export const fresh = <A, E>(
  test: Effect.Effect<A, E, BenchRunsRepo | SweepsRepo | ProfilesRepo | SqlClient.SqlClient>,
) =>
  Layer.build(Fresh).pipe(
    Effect.flatMap((context) => Effect.provideContext(test, context)),
    Effect.scoped,
  );

/** A llama-bench spec of `/m/a.gguf` with the defaults of `BenchSpec`, `fields` over them. */
export const benchSpec = (fields: Partial<BenchSpec> = {}): BenchSpec => ({
  kind: 'bench',
  modelPath: '/m/a.gguf',
  mmprojPath: null,
  profileId: null,
  p: 512,
  n: 128,
  r: 3,
  params: {},
  serverArgs: [],
  ...fields,
});

/** A sweep of `/m/a.gguf` over `-ncmoe` 0, 8 and 16 with the defaults of `SweepSpec`, `fields` over them. */
export const sweepSpec = (fields: Partial<SweepSpec> = {}): SweepSpec => ({
  name: 's',
  modelPath: '/m/a.gguf',
  mmprojPath: null,
  profileId: null,
  p: 512,
  n: 128,
  r: 3,
  preset: 'chat',
  base: {},
  space: { ncmoe: [0, 8, 16] },
  serverArgs: [],
  includeUnfit: false,
  ...fields,
});

/** The hardware of a run whose machine was not read. */
export const NO_HARDWARE: BenchHardware = { cpu: '', gpus: [], build: null };
