import { HttpApi } from 'effect/http-api';
import { HealthApi } from './HealthApi.ts';

/**
 * The HTTP API of llama-webui: the server implements it (`app/server/`), the web derives its client from it. One group
 * per domain; every milestone adds its groups here.
 */
export class Api extends HttpApi.make('llama-webui').add(HealthApi) {}
