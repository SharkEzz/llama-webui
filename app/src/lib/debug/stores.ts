import { debugStoreChange, isDebugEnabled, onCaptureStart, onCaptureStop } from './capture';

/**
 * The page's stores, as the debug window lists them. Each store module registers its store when it loads: the window
 * imports none (loading a store module from the window would start what it starts, a subscription to the socket, a
 * first fetch). While the capture runs, each store is subscribed to and its changes go to the capture.
 */

interface Store<S> {
  getState: () => S;
  subscribe: (listener: (state: S, prev: S) => void) => () => void;
}

interface Entry {
  getState: () => unknown;
  /** Subscribes to the store; gives what unsubscribes. */
  subscribe: () => () => void;
  unsubscribe?: () => void;
}

const entries = new Map<string, Entry>();

function watch(entry: Entry): void {
  entry.unsubscribe?.();
  entry.unsubscribe = entry.subscribe();
}

function unwatch(entry: Entry): void {
  entry.unsubscribe?.();
  delete entry.unsubscribe;
}

/**
 * Registers `store` under `name`. A store registered again under the same name (its module reloaded by Vite's HMR)
 * replaces the first, whose subscription goes.
 */
export function debugStore<S>(name: string, store: Store<S>): void {
  const previous = entries.get(name);
  if (previous) unwatch(previous);
  const entry: Entry = {
    getState: store.getState,
    subscribe: () => store.subscribe((state, prev) => debugStoreChange(name, state, prev)),
  };
  entries.set(name, entry);
  if (isDebugEnabled()) watch(entry);
}

onCaptureStart(() => {
  for (const entry of entries.values()) watch(entry);
});
onCaptureStop(() => {
  for (const entry of entries.values()) unwatch(entry);
});

/** The stores loaded so far, by name. */
export function debugStores(): ReadonlyMap<string, { getState: () => unknown }> {
  return new Map([...entries].map(([name, entry]) => [name, { getState: entry.getState }]));
}
