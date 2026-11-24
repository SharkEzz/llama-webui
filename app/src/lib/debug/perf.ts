import { debugInteraction, debugLongTask } from './capture';

/** An interaction shorter than this is not reported by the browser (event timing's minimum is 16 ms). */
const INTERACTION_MIN_MS = 40;

let observers: PerformanceObserver[] = [];

/** Observes `type` if the browser supports it (long tasks: Chromium only). */
function observe(type: string, onEntry: (entry: PerformanceEntry) => void, options: PerformanceObserverInit = {}) {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes.includes(type)) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onEntry(entry);
  });
  observer.observe({ type, buffered: false, ...options });
  observers.push(observer);
}

/** Long tasks and interactions, while the debug mode is on. */
export function startPerfObservers(): void {
  if (observers.length > 0) return;
  observe('longtask', (entry) => debugLongTask(entry.duration));
  observe(
    'event',
    (entry) => {
      // An interaction (a click, a key) has an id; a hover or a scroll has none.
      if ('interactionId' in entry && typeof entry.interactionId === 'number' && entry.interactionId > 0)
        debugInteraction(entry.name, entry.duration);
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `durationThreshold` is in the spec and Chromium, not yet in TypeScript's DOM types
    { durationThreshold: INTERACTION_MIN_MS } as PerformanceObserverInit,
  );
}

export function stopPerfObservers(): void {
  for (const o of observers) o.disconnect();
  observers = [];
}
