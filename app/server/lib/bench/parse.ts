import { OOM_ERROR } from '@llama-webui/shared';
import { ERROR_LINE, OOM_LINE } from 'llamacpp-js/bench';

/** Why a run failed, based on the tool's last lines. */
export function benchFailure(
  lines: string[],
  exit: number | string,
  tool = 'llama-bench',
): { message: string; oom: boolean } {
  const oom = lines.some((l) => OOM_LINE.test(l));
  // OOM: the allocation line (“unable to allocate CUDA1 buffer”) rather than the “failed to load model” that follows.
  const line = [...lines]
    .reverse()
    .find((l) => (oom ? OOM_LINE : ERROR_LINE).test(l))
    ?.trim();
  if (!line) return { oom, message: oom ? OOM_ERROR : `${tool} exited (code ${exit})` };
  return { oom, message: oom ? `${OOM_ERROR}: ${line}` : line };
}
