import { HttpApiMiddleware } from 'effect/http-api';
import { RequestInvalid, RouteNotFound } from './errors.ts';

/**
 * The middleware every endpoint carries: what a request that does not decode is answered. A payload or a query is a
 * 400 `RequestInvalid` with its issues, a path parameter the 404 of an unknown route.
 */
export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()('@llama-webui/shared/api/RequestErrors', {
  error: [RequestInvalid, RouteNotFound],
}) {}
