import { RequestErrors, RouteNotFound, requestInvalid } from '@llama-webui/shared';
import { Effect, type Layer } from 'effect';
import { HttpApiMiddleware } from 'effect/http-api';

/**
 * What a request that does not decode is answered: a path parameter is the 404 of an unknown route (`/api/profiles/abc`
 * names no profile), a payload, a query or a header the 400 `RequestInvalid` with every issue. A reply that does not
 * encode (`Body`, `ResponseHeaders`) is a bug of the server: it stays the 500 it is.
 */
export const RequestErrorsLive: Layer.Layer<RequestErrors> = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestErrors,
  (error) => {
    switch (error.kind) {
      case 'Params':
        return Effect.fail(RouteNotFound.make({ message: 'Unknown route' }));
      case 'Payload':
      case 'Query':
      case 'Headers':
        return Effect.fail(requestInvalid(error.cause.issue));
      default:
        return Effect.fail(error);
    }
  },
);
