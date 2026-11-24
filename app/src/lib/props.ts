import type { ServerState } from '@llama-webui/shared';
import { call } from './api';

/** A JSON object (not an array, not null). */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What llama-server's /props says about default sampling, context and the loaded model. */
export interface ServerProps {
  model_path?: string;
  default_generation_settings?: { n_ctx?: number; params?: Record<string, unknown> };
}

/** The fields of `ServerProps` found with their type in llama-server's untyped /props reply. */
export function serverPropsOf(raw: unknown): ServerProps {
  if (!isRecord(raw)) return {};
  const out: ServerProps = {};
  if (typeof raw.model_path === 'string') out.model_path = raw.model_path;
  const gen = raw.default_generation_settings;
  if (isRecord(gen)) {
    out.default_generation_settings = {};
    if (typeof gen.n_ctx === 'number') out.default_generation_settings.n_ctx = gen.n_ctx;
    if (isRecord(gen.params)) out.default_generation_settings.params = gen.params;
  }
  return out;
}

/** GET /api/server/props: llama-server's own JSON, untyped (an object, otherwise empty). */
export const getServerProps = async (): Promise<Record<string, unknown>> => {
  const raw: unknown = await call((api) => api.server.props());
  return isRecord(raw) ? raw : {};
};

/** Whether the external server said it is loaded, and how many times /props had to be asked again (`propsRetry`). */
export interface PropsRetry {
  readonly loaded: boolean;
  readonly n: number;
}

/** True once an external server says, on `/models/sse`, that its model is loaded. */
export const isExternalLoaded = (state: ServerState | undefined): boolean =>
  state?.kind === 'external' && state.status === 'ready';

/**
 * An external server found while it still loads answers 503 on /props, and when its load ends nothing of its state
 * changes but its status. `n` grows each time that status turns loaded while no /props is held (`missing`): a trigger
 * to ask again. A wake-up from sleep turns it loaded too, with the props held: nothing is asked again.
 */
export const propsRetry = (
  retry: PropsRetry,
  now: { readonly loaded: boolean; readonly missing: boolean },
): PropsRetry =>
  now.loaded === retry.loaded ? retry : { loaded: now.loaded, n: now.loaded && now.missing ? retry.n + 1 : retry.n };
