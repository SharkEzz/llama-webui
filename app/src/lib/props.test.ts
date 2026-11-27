import { expect, test } from 'vitest';
import { isExternalLoaded, propsRetry } from './props';

test('isExternalLoaded: an external server whose /models/sse status is ready', () => {
  expect(isExternalLoaded({ kind: 'external', pid: 7, port: 8081, status: 'ready' })).toBe(true);
  expect(isExternalLoaded({ kind: 'external', pid: 7, port: 8081, status: 'loading' })).toBe(false);
  expect(isExternalLoaded({ kind: 'external', pid: 7, port: 8081 })).toBe(false);
  expect(isExternalLoaded({ kind: 'idle' })).toBe(false);
  expect(isExternalLoaded(undefined)).toBe(false);
});

test('propsRetry asks /props again when an external server ends the load it was found in, not on a wake-up', () => {
  // Found while loading: /props answered 503, nothing is held
  const found = { loaded: false, n: 0 };
  expect(propsRetry(found, { loaded: false, missing: true })).toBe(found);
  const loaded = propsRetry(found, { loaded: true, missing: true });
  expect(loaded).toEqual({ loaded: true, n: 1 });
  // Nothing more to ask while it stays loaded, whatever is held
  expect(propsRetry(loaded, { loaded: true, missing: true })).toBe(loaded);
  // Asleep, then awake again with its props held: no reread
  const asleep = propsRetry(loaded, { loaded: false, missing: false });
  expect(asleep).toEqual({ loaded: false, n: 1 });
  expect(propsRetry(asleep, { loaded: true, missing: false })).toEqual({ loaded: true, n: 1 });
  // A wake-up without props (the first read failed): asked again
  expect(propsRetry(asleep, { loaded: true, missing: true })).toEqual({ loaded: true, n: 2 });
});
