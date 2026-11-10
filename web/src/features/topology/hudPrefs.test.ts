import { expect, test } from 'bun:test';
import { parseCollapsed } from './hudPrefs';

test('parseCollapsed: cards are open by default, only known cards and booleans are kept', () => {
  expect(parseCollapsed(null)).toEqual({ phase: false, model: false });
  expect(parseCollapsed('{"model":true}')).toEqual({ phase: false, model: true });
  expect(parseCollapsed('{"phase":true,"model":"yes","legend":true}')).toEqual({ phase: true, model: false });
});

test('parseCollapsed: unreadable storage falls back to open cards', () => {
  expect(parseCollapsed('not json')).toEqual({ phase: false, model: false });
  expect(parseCollapsed('null')).toEqual({ phase: false, model: false });
  expect(parseCollapsed('[true]')).toEqual({ phase: false, model: false });
});
