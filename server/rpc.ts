import { createApi } from './api';

/**
 * Never called: its inferred return type is the API's full route schema, which the web's `hc` client reads.
 */
export const apiSchema = () => createApi(undefined as never);

/** The API's type, for `hc<AppType>()` in the web app (`@llama-webui/server/api`). */
export type AppType = ReturnType<typeof apiSchema>;
