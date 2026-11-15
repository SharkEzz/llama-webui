import {
  estimatedSweepSeconds,
  expandSpace,
  itemLabel,
  type PlanItem,
  type PlanResult,
  type SweepSpec,
  sweepCtx,
  type TuningHardware,
} from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf.ts';
import { cacheOf } from './estimate.ts';
import { fitOf } from './placement.ts';

export interface PlanInput {
  readonly model: ModelInfo;
  readonly hw: TuningHardware;
  readonly spec: SweepSpec;
  readonly mmprojBytes: number;
}

/**
 * The items of a sweep, each with the estimator's verdict; those that don't fit are dropped unless `includeUnfit`.
 * Each item is measured with the cache types llama.cpp gives it: `-ctv` defaults to f16, not to `-ctk`.
 */
export const planSweep = ({ model, hw, spec, mmprojBytes }: PlanInput): PlanResult => {
  const ctx = sweepCtx(spec);
  const { items: all, droppedTs } = expandSpace(spec.base, spec.space);
  const items: Array<PlanItem> = [];
  let excluded = 0;
  for (const params of all) {
    const fit = fitOf({
      model,
      devices: hw.devices,
      params,
      ctx,
      kv: cacheOf(params),
      ub: params.ub ?? 512,
      mmprojBytes,
      ramAvailableBytes: hw.ramAvailableBytes,
    });
    if (fit.verdict === 'no' && !spec.includeUnfit) {
      excluded++;
      continue;
    }
    items.push({ params, label: itemLabel(params, spec.space), fit });
  }
  return {
    items,
    excluded,
    droppedTs,
    estimatedSeconds: estimatedSweepSeconds({ items: items.length, fileBytes: model.fileBytes, r: spec.r }),
  };
};
