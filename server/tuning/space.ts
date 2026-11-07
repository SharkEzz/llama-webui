import {
  type BenchParams,
  type CacheType,
  estimatedSweepSeconds,
  expandSpace,
  itemLabel,
  type PlanResult,
  type SweepSpec,
  sweepCtx,
  type TuningHardware,
} from "@llama-webui/shared";
import type { ModelInfo } from "../models/gguf";
import { fitOf } from "./placement";

/** Les éléments d'un sweep, chacun avec le verdict de l'estimateur ; ceux qui ne tiennent pas retirés sauf `includeUnfit`. */
export function planSweep(o: {
  model: ModelInfo;
  hw: TuningHardware;
  spec: SweepSpec;
  mmprojBytes: number;
}): PlanResult {
  const { spec } = o;
  const ctx = sweepCtx(spec);
  const { items: all, droppedTs } = expandSpace(spec.base, spec.space);
  const items: PlanResult["items"] = [];
  let excluded = 0;
  for (const params of all) {
    const fit = fitOf({
      model: o.model,
      devices: o.hw.devices,
      params,
      ctx,
      kv: { k: (params.ctk ?? "f16") as CacheType, v: (params.ctv ?? params.ctk ?? "f16") as CacheType },
      ub: params.ub ?? 512,
      mmprojBytes: o.mmprojBytes,
      ramAvailableBytes: o.hw.ramAvailableBytes,
    });
    if (fit.verdict === "no" && !spec.includeUnfit) {
      excluded++;
      continue;
    }
    items.push({ params: params as BenchParams, label: itemLabel(params, spec.space), fit });
  }
  return {
    items,
    excluded,
    droppedTs,
    estimatedSeconds: estimatedSweepSeconds(items.length, o.model.fileBytes, spec.r),
  };
}
