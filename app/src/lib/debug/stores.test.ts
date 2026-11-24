import { afterEach, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { setDebugEnabled, snapshot } from './capture';
import { debugStore, debugStores } from './stores';

afterEach(() => setDebugEnabled(false));

const counter = () =>
  createStore<{ n: number; label: string; inc: () => void }>()((set) => ({
    n: 0,
    label: 'a',
    inc: () => set((s) => ({ n: s.n + 1 })),
  }));

test('a store is listened to only while the capture runs, registered before or after it starts', () => {
  const before = counter();
  debugStore('before', before);
  before.getState().inc();
  setDebugEnabled(true);
  const after = counter();
  debugStore('after', after);
  before.getState().inc();
  after.getState().inc();
  expect(snapshot().storeChanges.map((c) => [c.store, c.keys, c.prev, c.next])).toEqual([
    ['before', ['n'], { n: 1 }, { n: 2 }],
    ['after', ['n'], { n: 0 }, { n: 1 }],
  ]);
  setDebugEnabled(false);
  setDebugEnabled(true);
  // The subscriptions let go at the stop are taken again at the start, once.
  before.getState().inc();
  expect(snapshot().storeChanges).toHaveLength(1);
  setDebugEnabled(false);
  before.getState().inc();
  expect(snapshot().storeChanges).toEqual([]);
});

test('a store registered again under its name replaces the first (a module reloaded by HMR)', () => {
  setDebugEnabled(true);
  const first = counter();
  const second = counter();
  debugStore('hmr', first);
  debugStore('hmr', second);
  first.getState().inc();
  second.getState().inc();
  expect(snapshot().storeChanges.filter((c) => c.store === 'hmr')).toHaveLength(1);
  expect(debugStores().get('hmr')?.getState()).toBe(second.getState());
});

test('a set() that changes nothing is counted, not logged', () => {
  setDebugEnabled(true);
  const store = counter();
  debugStore('noop', store);
  store.setState({ label: 'a' });
  store.setState({ label: 'b' });
  const stats = snapshot().storeStats.find((s) => s.store === 'noop');
  expect(stats).toMatchObject({ changes: 1, noops: 1 });
  expect(snapshot().storeChanges.map((c) => c.keys)).toEqual([['label']]);
});
