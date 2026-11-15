import { Array as Arr, String as Str, Stream } from 'effect';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC (\x1b).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** A line without its ANSI escape sequences, its trailing `\r` and its trailing whitespace. */
const clean = (line: string): string => Str.trimEnd(Str.replace(/\r$/, '')(Str.replaceAll(ANSI, '')(line)));

/** The clean lines among `parts`, the empty ones dropped. */
const kept = (parts: ReadonlyArray<string>): ReadonlyArray<string> => Arr.filter(Arr.map(parts, clean), Str.isNonEmpty);

/**
 * The lines of a stream of bytes: decoded as UTF-8 across chunks, split on `\n`, cleaned, empty ones dropped; the last
 * line is emitted when the stream ends, even without its `\n`.
 */
export const linesOf = <E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<string, E> =>
  bytes.pipe(
    Stream.decodeText,
    Stream.mapAccum(
      () => '',
      (rest: string, chunk: string) => {
        const parts = Str.split(rest + chunk, '\n');
        return [Arr.lastNonEmpty(parts), kept(Arr.initNonEmpty(parts))] as const;
      },
      { onHalt: (rest) => kept([rest]) },
    ),
  );

/**
 * A line llama-server writes from -lv 4 on each time a request (the monitor's `/slots` and `/metrics`, every
 * second) wakes its idle loop: kept out of the ring, it would push everything else out of it within the hour.
 */
const IDLE_NOISE = /\bupdate_slots: all slots are idle\s*$/;

export const isIdleNoise = (line: string): boolean => IDLE_NOISE.test(line);
