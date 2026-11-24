import { expect, test } from 'vitest';
import { childPath, childrenOf, diffPaths, isBranch, preview, sizeOf } from './inspect';

test('a branch lists its children, without its actions; a leaf has none', () => {
  expect(childrenOf({ a: 1, load: () => {}, b: [2] })).toEqual([
    ['a', 1],
    ['b', [2]],
  ]);
  expect(childrenOf(new Map([[1, 'x']]))).toEqual([['1', 'x']]);
  expect(childrenOf(new Set(['x']))).toEqual([['0', 'x']]);
  expect(sizeOf({ a: 1, load: () => {} })).toBe(1);
  for (const leaf of [1, 'x', null, undefined, new Date(0), new Uint8Array(2), () => {}])
    expect(isBranch(leaf), String(leaf)).toBe(false);
});

test('a value fits on one line', () => {
  expect(preview('a "b"')).toBe('"a \\"b\\""');
  expect(preview('x'.repeat(200), 10)).toHaveLength(10);
  expect(preview([1, 2, 3])).toBe('Array(3)');
  expect(preview(new Map([[1, 2]]))).toBe('Map(1)');
  expect(preview({ id: 1, name: 'a', load: () => {} })).toBe('{ id, name }');
  expect(preview({ alpha: 1, beta: 2, gamma: 3, delta: 4 }, 20)).toBe('{ alpha, beta, … }');
  expect(preview(3n)).toBe('3n');
});

test('a path names a key as code would', () => {
  expect(childPath('', 'models', false)).toBe('models');
  expect(childPath('models', '3', true)).toBe('models[3]');
  expect(childPath('env', 'A-B', false)).toBe('env["A-B"]');
});

test('a diff lists what was added, removed and changed, path by path', () => {
  const shared = { big: [1, 2, 3] };
  const prev = { shared, list: [1, 2], byId: new Map([[1, 'a']]), status: 'idle', gone: true };
  const next = { shared, list: [1, 3, 4], byId: new Map([[1, 'b']]), status: 'running', added: 1 };
  expect(diffPaths(prev, next, { root: 'state' }).entries).toEqual([
    { path: 'state.list[1]', kind: 'changed', before: 2, after: 3 },
    { path: 'state.list[2]', kind: 'added', after: 4 },
    { path: 'state.byId["1"]', kind: 'changed', before: 'a', after: 'b' },
    { path: 'state.status', kind: 'changed', before: 'idle', after: 'running' },
    { path: 'state.gone', kind: 'removed', before: true },
    { path: 'state.added', kind: 'added', after: 1 },
  ]);
});

test('a diff stops at its depth and at its number of entries', () => {
  expect(diffPaths({ a: { b: 1 } }, { a: { b: 2 } }, { maxDepth: 1 }).entries).toEqual([
    { path: 'a', kind: 'changed', before: { b: 1 }, after: { b: 2 } },
  ]);
  const many = diffPaths(
    Array.from({ length: 10 }, () => 0),
    Array.from({ length: 10 }, () => 1),
    { maxEntries: 3 },
  );
  expect(many.entries).toHaveLength(3);
  expect(many.truncated).toBe(true);
  // A value replaced by one of another kind is one change.
  expect(diffPaths([1], { 0: 1 }).entries).toEqual([{ path: '', kind: 'changed', before: [1], after: { 0: 1 } }]);
});
