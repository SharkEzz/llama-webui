import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

/** `<binary> --help` did not give a catalogue: `llama-server --help failed (<binary>)`. */
export class FlagsUnavailable extends Schema.TaggedError<
  FlagsUnavailable,
  { readonly FlagsUnavailable: unique symbol }
>()('FlagsUnavailable', { message: Schema.String }, { httpApiStatus: 503 }) {}

/** A flag of llama-server, as llamacpp-js reads it from `--help` (its `Flag`). */
export const Flag = Schema.Struct({
  names: Schema.Array(Schema.String),
  value: Schema.optionalKey(Schema.String),
  help: Schema.String,
  section: Schema.String,
});

/** The flags the configured llama-server accepts. */
export class FlagsApi extends HttpApiGroup.make('flags').add(
  HttpApiEndpoint.get('get', '/api/flags', {
    success: Schema.Struct({ flags: Schema.Array(Flag) }),
    error: FlagsUnavailable,
  }),
) {}
