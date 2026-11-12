import { call, client } from './api';

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
  const raw: unknown = await call(client.server.props.$get());
  return isRecord(raw) ? raw : {};
};
