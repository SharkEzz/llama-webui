import { Effect, Schema, Stream } from 'effect';
import { dual } from 'effect/Function';

/** A child process wrote more bytes than the caller allows. */
export class OutputTooLarge extends Schema.TaggedError<OutputTooLarge, { readonly OutputTooLarge: unique symbol }>()(
  'OutputTooLarge',
  {
    maxBytes: Schema.Int,
    message: Schema.String,
  },
) {}

/**
 * Decodes `stream` as UTF-8 text while capping the total byte count at `maxBytes`.
 * Fails with `OutputTooLarge` as soon as the cap is exceeded so a runaway child process cannot exhaust memory.
 */
export const boundedText: {
  (maxBytes: number): <E, R>(stream: Stream.Stream<Uint8Array, E, R>) => Effect.Effect<string, E | OutputTooLarge, R>;
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>, maxBytes: number): Effect.Effect<string, E | OutputTooLarge, R>;
} = dual(
  2,
  <E, R>(stream: Stream.Stream<Uint8Array, E, R>, maxBytes: number): Effect.Effect<string, E | OutputTooLarge, R> =>
    Effect.suspend(() => {
      let size = 0;
      const capped = Stream.mapEffect(stream, (chunk) => {
        size += chunk.length;
        return size > maxBytes
          ? Effect.fail(OutputTooLarge.make({ maxBytes, message: `Output exceeded ${maxBytes} bytes` }))
          : Effect.succeed(chunk);
      });
      return Stream.mkString(Stream.decodeText(capped));
    }),
);
