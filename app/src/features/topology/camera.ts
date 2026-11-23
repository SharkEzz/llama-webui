import { fitScale, type Point, type Rect } from './geometry';

/*
 * Where the drawing stands in its frame once it can be zoomed and moved: pure functions of the camera, the frame
 * and the drawing's natural size.
 */

/** A point `p` of the drawing shows at `x + p.x * scale`, `y + p.y * scale` of its frame. */
export interface Camera {
  scale: number;
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

/** Largest scale of the drawing: beyond it the text of a block is larger than a title. */
export const ZOOM_MAX = 4;
/** What a click on a zoom button multiplies the scale by. */
export const ZOOM_STEP = 1.25;
/** Room kept between a block brought into view and the edge of the frame, in px. */
const REVEAL_MARGIN = 16;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Along one axis: a drawing larger than its frame covers it, a smaller one stays inside it. */
function bound(offset: number, drawn: number, room: number): number {
  return drawn > room ? clamp(offset, room - drawn, 0) : clamp(offset, 0, room - drawn);
}

function bounded(camera: Camera, frame: Size, natural: Size): Camera {
  return {
    scale: camera.scale,
    x: bound(camera.x, natural.w * camera.scale, frame.w),
    y: bound(camera.y, natural.h * camera.scale, frame.h),
  };
}

/** The whole drawing, centered in its frame: what the page shows until someone zooms or moves it. */
export function fitCamera(frame: Size, natural: Size): Camera {
  const scale = fitScale(frame, natural);
  return { scale, x: (frame.w - natural.w * scale) / 2, y: (frame.h - natural.h * scale) / 2 };
}

/**
 * The camera after a zoom by `factor` around the point `at` of the frame, which keeps showing the same point of the
 * drawing. The scale goes from the whole drawing to `ZOOM_MAX`; back at the whole drawing, the camera is `fitCamera`.
 */
export function zoomAt(camera: Camera, factor: number, at: Point, frame: Size, natural: Size): Camera {
  const fit = fitCamera(frame, natural);
  const scale = clamp(camera.scale * factor, fit.scale, Math.max(fit.scale, ZOOM_MAX));
  if (scale <= fit.scale) return fit;
  const k = scale / camera.scale;
  return bounded({ scale, x: at.x - (at.x - camera.x) * k, y: at.y - (at.y - camera.y) * k }, frame, natural);
}

/** The camera after a move of the drawing by `dx`, `dy` px of the frame, as far as its bounds allow. */
export function panBy(camera: Camera, dx: number, dy: number, frame: Size, natural: Size): Camera {
  return bounded({ scale: camera.scale, x: camera.x + dx, y: camera.y + dy }, frame, natural);
}

/**
 * The camera that shows `rect` (a block, in px of the frame) whole, moved as little as possible; the same camera
 * when the block already shows.
 */
export function reveal(camera: Camera, rect: Rect, frame: Size, natural: Size): Camera {
  const shift = (start: number, size: number, room: number) => {
    if (start < REVEAL_MARGIN) return REVEAL_MARGIN - start;
    const over = start + size - (room - REVEAL_MARGIN);
    return over > 0 ? -Math.min(over, start - REVEAL_MARGIN) : 0;
  };
  const dx = shift(rect.x, rect.w, frame.w);
  const dy = shift(rect.y, rect.h, frame.h);
  return dx === 0 && dy === 0 ? camera : panBy(camera, dx, dy, frame, natural);
}

/**
 * The camera to draw with: `chosen` (what someone zoomed or moved to, null for none) inside the bounds of a frame
 * that may have changed since, or the whole drawing when there is no choice or when it shows less than the whole.
 */
export function resolveCamera(chosen: Camera | null, frame: Size, natural: Size): Camera {
  const fit = fitCamera(frame, natural);
  return chosen === null || chosen.scale < fit.scale ? fit : bounded(chosen, frame, natural);
}
