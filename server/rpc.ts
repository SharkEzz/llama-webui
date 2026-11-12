import { createApi } from './api';

/**
 * Never called: its inferred return type is the API's full route schema, which the declaration emit writes out in
 * `rpc.d.ts` with no import of the server's runtime modules (and so none of Node's types). The web's `hc` client reads it.
 */
export const apiSchema = () => createApi(undefined as never);

/** The API's type, for `hc<AppType>()` in the web app (`@llama-webui/server/api`). */
export type AppType = ReturnType<typeof apiSchema>;
