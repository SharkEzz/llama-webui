import type { ModelPlacement, TopologyGraph } from '@llama-webui/shared';
import { create } from 'zustand';
import { call as webCall } from './api';
import { onWs, useWs, type WsStatus } from './ws';

interface TopologyState {
  /** Hardware graph (sysfs); null until it has been read. */
  graph: TopologyGraph | null;
  /** Placement of the loaded model; null without a managed server or until the logs have provided it. */
  placement: ModelPlacement | null;
  /** The last read of /api/topology failed. */
  error: boolean;
}

/** What the store follows of the push channel: its status (the web's `useWs`, or a store of a test). */
interface WsLike {
  getState: () => { readonly status: WsStatus };
  subscribe: (
    listener: (state: { readonly status: WsStatus }, prev: { readonly status: WsStatus }) => void,
  ) => () => void;
}

/** The calls and the channel the store uses: the web's, or in a test a fake `fetch` and a store of its own. */
export interface TopologyDeps {
  readonly call: typeof webCall;
  readonly ws: WsLike;
}

/**
 * The topology's store. Only the Topology page shows the graph, so only it asks for it (`watch`): once when it is
 * shown, then on each reconnect of the push channel while it is (a `placement` missed while the channel was down).
 * `receive` applies the `placement` messages, followed from the app's start.
 */
export const makeTopology = ({ call, ws }: TopologyDeps) => {
  const store = create<TopologyState>()(() => ({ graph: null, placement: null, error: false }));
  /** Sequence number of the last placement received over WS: a REST response sent before it must not overwrite it. */
  let placementSeq = 0;
  let requestSeq = 0;

  /** Rereads the graph (current link state changes with power states) and the placement. */
  const refresh = async (): Promise<void> => {
    const req = ++requestSeq;
    const seenPlacement = placementSeq;
    try {
      const r = await call((api) => api.monitor.topology());
      if (req !== requestSeq) return; // a newer reread is in flight: it wins
      store.setState(
        placementSeq === seenPlacement
          ? { graph: r.graph, placement: r.placement, error: false }
          : { graph: r.graph, error: false },
      );
    } catch {
      if (req === requestSeq) store.setState({ error: true });
    }
  };

  /** A `placement` message. */
  const receive = (placement: ModelPlacement | null): void => {
    placementSeq++;
    store.setState({ placement });
  };

  /**
   * Reads the graph while a page shows it; the returned function stops. With the channel open, at once; while it
   * connects, once it opens (one read on a cold load, after which no placement message is missed); with the channel
   * down, at once (the page shows the graph or the failure without waiting). Then again on each reconnect.
   */
  const watch = (): (() => void) => {
    let read = false;
    const readNow = () => {
      read = true;
      void refresh();
    };
    if (ws.getState().status !== 'connecting') readNow();
    return ws.subscribe((s, prev) => {
      if (s.status === 'open' && prev.status !== 'open') readNow();
      // The first connection failed: read anyway, the page then says whether the server answers.
      else if (s.status === 'closed' && !read) readNow();
    });
  };

  return { store, refresh, receive, watch };
};

const topology = makeTopology({ call: webCall, ws: useWs });

export const useTopology = topology.store;
/** Reads the graph while the calling page is shown (see `makeTopology`): call it in an effect, return what it returns. */
export const watchTopology = topology.watch;

let started = false;
/** Feeds the store with the “placement” messages (at startup); the graph itself is read by the page (`watchTopology`). */
export function startTopologySync(): void {
  if (started) return;
  started = true;
  onWs('placement', (m) => topology.receive(m.payload));
}
