import { expect, test } from 'vitest';
import { clampRect, defaultRect, dragRect, HEADER_HEIGHT, MIN_HEIGHT, MIN_WIDTH, parseRect } from './geometry';

const view = { width: 1280, height: 800 };

test('the window opens bottom right, inside the viewport', () => {
  const r = defaultRect(view);
  expect(r.x + r.width).toBeLessThanOrEqual(view.width);
  expect(r.y + r.height).toBeLessThan(view.height);
  expect(r.width).toBeGreaterThanOrEqual(MIN_WIDTH);
});

test('a rect keeps the minimum size and its header on screen', () => {
  expect(clampRect({ x: 100, y: 100, width: 10, height: 10 }, view)).toEqual({
    x: 100,
    y: 100,
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
  });
  // Dragged out by the bottom right: its header is brought back.
  const out = clampRect({ x: 5000, y: 5000, width: 400, height: 300 }, view);
  expect(out).toEqual({ x: view.width - 400, y: view.height - HEADER_HEIGHT, width: 400, height: 300 });
  // And by the top left.
  expect(clampRect({ x: -50, y: -50, width: 400, height: 300 }, view)).toMatchObject({ x: 0, y: 0 });
});

test('a viewport smaller than the minimum size holds the window whole', () => {
  expect(clampRect({ x: 0, y: 0, width: 640, height: 480 }, { width: 300, height: 200 })).toEqual({
    x: 0,
    y: 0,
    width: 300,
    height: 200,
  });
});

test('a drag moves by the header and resizes by the edges and the corner', () => {
  const r = { x: 10, y: 20, width: 400, height: 300 };
  expect(dragRect(r, 'move', 5, -5)).toEqual({ x: 15, y: 15, width: 400, height: 300 });
  expect(dragRect(r, 'right', 30, 99)).toEqual({ x: 10, y: 20, width: 430, height: 300 });
  expect(dragRect(r, 'bottom', 99, 30)).toEqual({ x: 10, y: 20, width: 400, height: 330 });
  expect(dragRect(r, 'corner', 30, 40)).toEqual({ x: 10, y: 20, width: 430, height: 340 });
});

test('a stored rect is read only when it is one', () => {
  expect(parseRect('{"x":1,"y":2,"width":400,"height":300}')).toEqual({ x: 1, y: 2, width: 400, height: 300 });
  for (const raw of [null, '', 'not json', '{"x":1}', '{"x":"1","y":2,"width":400,"height":300}', 'null'])
    expect(parseRect(raw), String(raw)).toBeUndefined();
});
