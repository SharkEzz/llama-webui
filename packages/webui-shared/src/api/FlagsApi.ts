import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';

/** `<binary> --help` did not give a catalogue: `llama-server --help failed (<binary>)`. */
export class FlagsUnavailable extends Schema.TaggedError<
  FlagsUnavailable,
  { readonly FlagsUnavailable: unique symbol }
>()(
  'FlagsUnavailable',
  { message: Schema.String },
  { httpApiStatus: 503, description: 'FlagsUnavailable: Running `llama-server --help` failed or timed out.' },
) {}

/** A flag of llama-server, as llamacpp-js reads it from `--help` (its `Flag`). */
export const Flag = Schema.Struct({
  names: Schema.Array(Schema.String),
  value: Schema.optionalKey(Schema.String),
  help: Schema.String,
  section: Schema.String,
}).annotate({
  identifier: 'Flag',
  description:
    'One CLI flag parsed from `llama-server --help` (names, optional value placeholder, help text and section).',
});

/** The flags the configured llama-server accepts. */
export class FlagsApi extends HttpApiGroup.make('flags')
  .add(
    HttpApiEndpoint.get('get', '/api/flags', {
      success: Schema.Struct({ flags: Schema.Array(Flag) }),
      error: FlagsUnavailable,
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List llama-server CLI flags',
        description:
          'Returns the parsed flag catalog of the configured `llama-server` binary (cached per binary path and mtime).',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Flags',
      description: 'CLI flag catalog parsed from `llama-server --help`.',
    }),
  ) {}
