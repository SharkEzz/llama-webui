import { describe, expect, test } from 'vitest';
import { type Camera, fitCamera, panBy, resolveCamera, reveal, ZOOM_MAX, zoomAt } from './camera';

const frame = { w: 1000, h: 600 };
const natural = { w: 500, h: 500 };
/** The drawing at 2.4 in the frame: 1200 × 1200, larger than it both ways. */
const close: Camera = { scale: 2.4, x: -100, y: -300 };

describe('fitCamera', () => {
  test('the whole drawing shows, centered in its frame', () => {
    expect(fitCamera(frame, natural)).toEqual({ scale: 1.2, x: 200, y: 0 });
    expect(fitCamera({ w: 400, h: 900 }, natural)).toEqual({ scale: 0.8, x: 0, y: 250 });
  });
});

describe('zoomAt', () => {
  test('the point under the pointer stays under it', () => {
    expect(zoomAt(fitCamera(frame, natural), 2, { x: 500, y: 300 }, frame, natural)).toEqual(close);
    const back = zoomAt(close, 0.75, { x: 500, y: 300 }, frame, natural);
    expect(back.scale).toBeCloseTo(1.8, 6);
    expect((500 - back.x) / back.scale).toBeCloseTo(250, 6);
    expect((300 - back.y) / back.scale).toBeCloseTo(250, 6);
  });

  test('the scale stops at its largest, and at the whole drawing', () => {
    expect(zoomAt(close, 100, { x: 500, y: 300 }, frame, natural).scale).toBe(ZOOM_MAX);
    expect(zoomAt(close, 0.01, { x: 20, y: 20 }, frame, natural)).toEqual(fitCamera(frame, natural));
  });

  test('zooming near an edge does not open a gap beside the drawing', () => {
    const zoomed = zoomAt(fitCamera(frame, natural), 2, { x: 990, y: 300 }, frame, natural);
    expect(zoomed.x).toBe(frame.w - natural.w * zoomed.scale);
  });
});

describe('panBy', () => {
  test('a drawing larger than its frame moves until one of its edges meets the frame', () => {
    expect(panBy(close, 60, -40, frame, natural)).toEqual({ scale: 2.4, x: -40, y: -340 });
    expect(panBy(close, 500, 500, frame, natural)).toEqual({ scale: 2.4, x: 0, y: 0 });
    expect(panBy(close, -5000, -5000, frame, natural)).toEqual({ scale: 2.4, x: -200, y: -600 });
  });

  test('a drawing smaller than its frame moves inside it', () => {
    const fit = fitCamera(frame, natural);
    expect(panBy(fit, 100, 50, frame, natural)).toEqual({ scale: 1.2, x: 300, y: 0 });
    expect(panBy(fit, 1000, 0, frame, natural)).toEqual({ scale: 1.2, x: 400, y: 0 });
    expect(panBy(fit, -1000, 0, frame, natural)).toEqual({ scale: 1.2, x: 0, y: 0 });
  });
});

describe('reveal', () => {
  test('a block out of the frame is brought inside it, with a margin', () => {
    expect(reveal(close, { x: 950, y: 100, w: 120, h: 80 }, frame, natural)).toEqual({ scale: 2.4, x: -186, y: -300 });
    expect(reveal(close, { x: 100, y: -60, w: 120, h: 80 }, frame, natural)).toEqual({ scale: 2.4, x: -100, y: -224 });
  });

  test('a block already in the frame moves nothing', () => {
    expect(reveal(close, { x: 100, y: 100, w: 120, h: 80 }, frame, natural)).toBe(close);
  });
});

describe('resolveCamera', () => {
  test('without a choice, the whole drawing', () => {
    expect(resolveCamera(null, frame, natural)).toEqual(fitCamera(frame, natural));
  });

  test('a choice is kept in a frame that changed, inside its bounds', () => {
    expect(resolveCamera(close, { w: 1100, h: 600 }, natural)).toEqual({ scale: 2.4, x: -100, y: -300 });
    expect(resolveCamera(close, { w: 1150, h: 1100 }, natural)).toEqual({ scale: 2.4, x: -50, y: -100 });
  });

  test('a choice smaller than the whole drawing in a frame that grew gives way to it', () => {
    const large = { w: 2000, h: 1500 };
    expect(resolveCamera({ scale: 1.2, x: 300, y: 0 }, large, natural)).toEqual(fitCamera(large, natural));
  });

  test('a frame not measured yet gives a usable camera', () => {
    expect(resolveCamera(close, { w: 0, h: 0 }, natural).scale).toBeGreaterThan(0);
  });
});
