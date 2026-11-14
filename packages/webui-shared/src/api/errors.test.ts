import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import { requestInvalid } from './errors.ts';
import { IdParam } from './params.ts';

/** The issue of a decode that must fail. */
const failureOf = (schema: Schema.ConstraintDecoder<unknown>, input: unknown) => {
  const result = Schema.decodeUnknownResult(schema, { errors: 'all' })(input);
  if (Result.isSuccess(result)) throw new Error('expected the decode to fail');
  return result.failure.issue;
};

test('requestInvalid words the first issue with its path and lists them all', () => {
  const schema = Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1, { message: 'cannot be empty' })),
    args: Schema.Array(Schema.String),
  });
  const error = requestInvalid(failureOf(schema, { name: '', args: ['a', 3] }));
  expect(error._tag).toBe('RequestInvalid');
  expect(error.message).toBe('Invalid data: cannot be empty (name)');
  expect(error.issues).toEqual([
    { path: ['name'], message: 'cannot be empty' },
    { path: ['args', '1'], message: expect.any(String) },
  ]);
});

test('an issue of the whole value has no path in the message', () => {
  const error = requestInvalid(failureOf(Schema.Struct({ name: Schema.String }), [1]));
  expect(error.message).toBe('Invalid data: Expected object');
  expect(error.issues[0]?.path).toEqual([]);
});

test('IdParam reads decimal digits only', () => {
  const decode = Schema.decodeUnknownResult(IdParam);
  expect(decode('12')).toEqual(Result.succeed(12));
  for (const input of ['abc', '0', '-1', '1.5', '', ' 1', '1e3', '0x10']) {
    expect(Result.isFailure(decode(input)), input).toBe(true);
  }
});
