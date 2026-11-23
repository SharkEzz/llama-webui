import { expect, test } from 'vitest';
import { parseView } from './viewPrefs';

test('parseView: the stored view is kept', () => {
  expect(parseView('board')).toBe('board');
  expect(parseView('cards')).toBe('cards');
});

test('parseView: a first visit, or anything unreadable, opens the cards', () => {
  expect(parseView(null)).toBe('cards');
  expect(parseView('')).toBe('cards');
  expect(parseView('3d')).toBe('cards');
  expect(parseView('Board')).toBe('cards');
  expect(parseView('{"model":true}')).toBe('cards');
});
