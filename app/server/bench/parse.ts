import { OOM_ERROR } from '@llama-webui/shared';
import { Array as Arr, Option, String as Str } from 'effect';
import { ERROR_LINE, OOM_LINE } from 'llamacpp-js/bench';

/** Why a run failed, from the tool's last lines and how it ended. */
export const benchFailure = (failure: {
  readonly lines: ReadonlyArray<string>;
  /** Its exit code or the signal that ended it, `-` when unknown. */
  readonly exit: number | string;
  readonly tool?: string;
}): { readonly message: string; readonly oom: boolean } => {
  const oom = Arr.some(failure.lines, (line) => OOM_LINE.test(line));
  // OOM: the allocation line (“unable to allocate CUDA1 buffer”) rather than the “failed to load model” that follows.
  const wanted = oom ? OOM_LINE : ERROR_LINE;
  const line = Arr.findLast(failure.lines, (l) => wanted.test(l)).pipe(
    Option.map(Str.trim),
    Option.filter(Str.isNonEmpty),
  );
  return Option.match(line, {
    onNone: () => ({
      oom,
      message: oom ? OOM_ERROR : `${failure.tool ?? 'llama-bench'} exited (code ${failure.exit})`,
    }),
    onSome: (found) => ({ oom, message: oom ? `${OOM_ERROR}: ${found}` : found }),
  });
};
