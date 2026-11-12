import { expect, test } from 'vitest';
import { navGroups, ROUTES } from './routes';

test('navGroups splits consecutive entries of the same group', () => {
  const routes = [
    { path: 'a', group: 'x' },
    { path: 'b', group: 'x' },
    { path: 'c', group: 'y' },
    { path: 'd', group: 'x' },
  ];
  expect(navGroups(routes).map((g) => g.map((r) => r.path))).toEqual([['a', 'b'], ['c'], ['d']]);
  expect(navGroups([])).toEqual([]);
});

test('each sidebar group is contiguous, so it gets a single divider', () => {
  const groups = navGroups(ROUTES).map((g) => g[0]!.group);
  expect(new Set(groups).size).toBe(groups.length);
});

test('Settings is the only entry of the settings group, and the last one', () => {
  expect(ROUTES.filter((r) => r.group === 'settings').map((r) => r.path)).toEqual(['/settings']);
  expect(ROUTES.at(-1)!.path).toBe('/settings');
});
