import { Effect, Schema } from 'effect';
import { HttpServerResponse } from 'effect/http';

/**
 * A JSON file to download, its body encoded with `schema`: 2-space indentation, a trailing newline,
 * `content-type: application/json`, `content-disposition: attachment; filename*=UTF-8''<percent-encoded filename>`.
 */
export const attachment = <A, I>(schema: Schema.Codec<A, I>) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema, { space: 2 }));
  return Effect.fn('attachment')(function* (file: { readonly filename: string; readonly body: A }) {
    const json = yield* Effect.orDie(encode(file.body));
    return HttpServerResponse.text(`${json}\n`, {
      contentType: 'application/json',
      headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` },
    });
  });
};
