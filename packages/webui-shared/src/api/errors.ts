import { Schema } from 'effect';

/** The guard refused the request (host, origin or body type): its status is the one the guard chose. */
export class RequestRefused extends Schema.TaggedError<RequestRefused, { readonly RequestRefused: unique symbol }>()(
  'RequestRefused',
  { message: Schema.String },
) {}

/** No endpoint of the API matches the path: `Unknown route`. */
export class RouteNotFound extends Schema.TaggedError<RouteNotFound, { readonly RouteNotFound: unique symbol }>()(
  'RouteNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}
