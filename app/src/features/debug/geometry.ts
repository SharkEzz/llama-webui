import { Option, Schema } from 'effect';
import { create } from 'zustand';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_WIDTH = 360;
export const MIN_HEIGHT = 240;
/** The window's header: always on screen, so the window can be moved back. */
export const HEADER_HEIGHT = 56;
/** Gap to the viewport's edges, and room for the debug button under the window. */
const MARGIN = 16;
const BUTTON_ROOM = 64;

/** The window as it first opens: bottom right, above the debug button. */
export function defaultRect(view: Viewport): Rect {
  const width = Math.min(640, view.width - 2 * MARGIN);
  const height = Math.min(480, view.height - MARGIN - BUTTON_ROOM);
  return clampRect({ x: view.width - MARGIN - width, y: view.height - BUTTON_ROOM - height, width, height }, view);
}

/**
 * `rect` kept usable in `view`: at least the minimum size (unless the viewport is smaller), no larger than the
 * viewport, and placed so its header is entirely on screen.
 */
export function clampRect(rect: Rect, view: Viewport): Rect {
  const width = Math.max(Math.min(rect.width, view.width), Math.min(MIN_WIDTH, view.width));
  const height = Math.max(Math.min(rect.height, view.height), Math.min(MIN_HEIGHT, view.height));
  const x = Math.min(Math.max(rect.x, 0), Math.max(view.width - width, 0));
  const y = Math.min(Math.max(rect.y, 0), Math.max(view.height - HEADER_HEIGHT, 0));
  return { x, y, width, height };
}

/** What a drag changes: the place (the header), or the size by the right edge, the bottom edge or the corner. */
export type DragKind = 'move' | 'right' | 'bottom' | 'corner';

/** A pointer moves at least this far (px) before a press on the header becomes a drag. */
export const DRAG_START = 4;

/** `rect` after a drag of `kind` by `(dx, dy)` from where it started (not clamped). */
export function dragRect(rect: Rect, kind: DragKind, dx: number, dy: number): Rect {
  switch (kind) {
    case 'move':
      return { ...rect, x: rect.x + dx, y: rect.y + dy };
    case 'right':
      return { ...rect, width: rect.width + dx };
    case 'bottom':
      return { ...rect, height: rect.height + dy };
    case 'corner':
      return { ...rect, width: rect.width + dx, height: rect.height + dy };
  }
}

const StoredRect = Schema.fromJsonString(
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite }),
);
const decodeRect = Schema.decodeUnknownOption(StoredRect);

/** The rect stored by the browser, if it is one. */
export function parseRect(raw: string | null): Rect | undefined {
  return raw === null ? undefined : Option.getOrUndefined(decodeRect(raw));
}

const KEY = 'llama-webui:debug-window';

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

function storedRect(): Rect {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  const r = parseRect(raw);
  return r ? clampRect(r, viewport()) : defaultRect(viewport());
}

interface DebugWindowState {
  /** In memory only: kept from one page to the next, closed after a reload. */
  open: boolean;
  /** Its place and size, kept by the browser (read when it first opens). */
  rect: Rect | null;
  setOpen: (open: boolean) => void;
  /** Moves or resizes it; `save` stores the rect (at the end of a drag). */
  setRect: (rect: Rect, save?: boolean) => void;
}

export const useDebugWindow = create<DebugWindowState>((set, get) => ({
  open: false,
  rect: null,
  setOpen(open) {
    set(open && !get().rect ? { open, rect: storedRect() } : { open });
  },
  setRect(rect, save = false) {
    const next = clampRect(rect, viewport());
    if (save)
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
    set({ rect: next });
  },
}));

/** The keys of the shortcut that opens and closes the window, as the button's title says it. */
export const SHORTCUT = 'Alt+Shift+D';

/**
 * Alt+Shift+D, by the key's place (`code`: the same on every layout). Ctrl+Shift+D would be the browsers' “bookmark
 * all tabs”.
 */
export function isToggleShortcut(
  e: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'repeat' | 'isComposing'>,
): boolean {
  return e.code === 'KeyD' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.repeat && !e.isComposing;
}
