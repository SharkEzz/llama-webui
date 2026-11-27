import type { ServerProps, ServerState } from '@llama-webui/shared';
import { call } from './api';

export type { ServerProps };

/** GET /api/server/props: llama-server's /props, the fields the app reads typed (`ServerProps`). */
export const getServerProps = (): Promise<ServerProps> => call((api) => api.server.props());

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
