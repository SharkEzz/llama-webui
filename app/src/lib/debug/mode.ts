import { create } from 'zustand';
import { setDebugEnabled } from './capture';
import { startPerfObservers, stopPerfObservers } from './perf';

const KEY = 'llama-webui:debug';

/** The debug mode as stored by the browser: on only when it says so. */
export function parseDebugMode(raw: string | null): boolean {
  return raw === 'on';
}

function stored(): boolean {
  try {
    return parseDebugMode(localStorage.getItem(KEY));
  } catch {
    return false;
  }
}

interface DebugModeState {
  /** The choice of this browser (each browser has its own: the capture costs the page that runs it). */
  on: boolean;
  setOn: (on: boolean) => void;
}

/** Starts or stops what the debug mode runs: the capture and the performance observers. */
function apply(on: boolean): void {
  setDebugEnabled(on);
  if (on) startPerfObservers();
  else stopPerfObservers();
}

export const useDebugMode = create<DebugModeState>((set) => ({
  on: false,
  setOn(on) {
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {}
    apply(on);
    set({ on });
  },
}));

/** Reads the stored choice and applies it: called before the WebSocket connects, so its `hello` is captured. */
export function startDebugSync(): void {
  const on = stored();
  apply(on);
  useDebugMode.setState({ on });
}
