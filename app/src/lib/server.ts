import { defer, type ServerView } from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { ApiError, api } from './api';
import { onWs, useWs } from './ws';

interface ServerStore {
  view: ServerView | null;
  /** A lifecycle action is in progress on the client. */
  busy: boolean;
}

export const useServer = create<ServerStore>()(() => ({ view: null, busy: false }));

async function refresh() {
  try {
    const st = await api('GET /api/state');
    useServer.setState({ view: st.server });
  } catch {
    // the WS is open but the API does not answer: the next reconnect will retry
  }
}

let started = false;
/** Feeds the store: “server-state” messages + a state reread on every (re)connect. */
export function startServerSync() {
  if (started) return;
  started = true;
  onWs('server-state', (m) => useServer.setState({ view: m.payload }));
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void refresh();
  });
}

async function action(send: () => Promise<ServerView>): Promise<boolean> {
  useServer.setState({ busy: true });
  using _busy = defer(() => useServer.setState({ busy: false }));
  try {
    const view = await send();
    useServer.setState({ view });
    return true;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : String(e));
    return false;
  }
}

export const startProfile = (profileId: number) => action(() => api('POST /api/server/start', { body: { profileId } }));
export const switchProfile = (profileId: number) =>
  action(() => api('POST /api/server/switch', { body: { profileId } }));
export const restartServer = () => action(() => api('POST /api/server/restart'));
export const stopServer = () => action(() => api('POST /api/server/stop'));

/** The (managed) server is running: it can be stopped, restarted or switched. */
export const isRunning = (v: ServerView | null) => v?.state.kind === 'starting' || v?.state.kind === 'ready';
