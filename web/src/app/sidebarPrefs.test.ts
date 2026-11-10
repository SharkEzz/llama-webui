import { expect, test } from 'bun:test';
import { parseCollapsed } from './sidebarPrefs';

test('parseCollapsed: the sidebar is expanded unless the browser stored "collapsed"', () => {
  expect(parseCollapsed(null)).toBe(false);
  expect(parseCollapsed('expanded')).toBe(false);
  expect(parseCollapsed('collapsed')).toBe(true);
  expect(parseCollapsed('true')).toBe(false);
  expect(parseCollapsed('')).toBe(false);
});
