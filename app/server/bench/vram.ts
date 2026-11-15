import { Option } from 'effect';

const MIB = 1024 * 1024;
const SMI_LINE = /^\s*(GPU-[\w-]+),\s*(\d+)\s*$/;

/** A line of `nvidia-smi --query-gpu=uuid,memory.used --format=csv,noheader,nounits -lms N`, with the monitor's key. */
export const parseSmiLine = (line: string): Option.Option<{ readonly key: string; readonly bytes: number }> =>
  Option.flatMap(Option.fromNullishOr(SMI_LINE.exec(line)), (match) =>
    match[1] === undefined || match[2] === undefined
      ? Option.none()
      : Option.some({ key: `nvidia:${match[1]}`, bytes: Number(match[2]) * MIB }),
  );
