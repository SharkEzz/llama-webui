import { Schema, SchemaTransformation } from 'effect';

/** A row id in a path: a positive integer written in decimal digits. */
export const IdParam: Schema.Codec<number, string> = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), SchemaTransformation.numberFromString),
);

/** A line number of the log: a non-negative integer written in decimal digits. */
export const SeqParam: Schema.Codec<number, string> = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), SchemaTransformation.numberFromString),
);
