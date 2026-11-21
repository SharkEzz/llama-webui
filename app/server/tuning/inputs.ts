import { Effect } from 'effect';
import { checkModelPaths } from '../models/allowedPath.ts';
import { checkPathForm, loadModel, mmprojBytes } from './models.ts';
import { TuningHardware } from './TuningHardware.ts';

/** The model, its projector's size and the hardware, read together once the paths are allowed. */
export const loadTuningInputs = Effect.fn('tuning.loadTuningInputs')(function* (files: {
  readonly modelPath: string;
  readonly mmprojPath?: string | null | undefined;
}) {
  const hardware = yield* TuningHardware;
  yield* checkPathForm(files.modelPath);
  yield* checkModelPaths(files);
  return yield* Effect.all(
    { model: loadModel(files.modelPath), mmproj: mmprojBytes(files.mmprojPath), hw: hardware.read },
    { concurrency: 'unbounded' },
  );
});
