import type { ProfilerOnRenderCallback } from 'react';
import { debugRender } from '@/lib/debug/capture';
import { fmt } from '@/lib/format';

/** A duration in ms: “12.3 ms”, “—” when unknown. */
export const ms = (v: number | undefined) => (v === undefined ? '—' : `${fmt(v, 1)} ms`);

/**
 * The `onRender` of the layout's `<Profiler>`s: `page` is counted under the page's path. React calls it in development
 * builds only; the capture drops it while the debug mode is off.
 */
export const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) =>
  debugRender(id === 'page' ? `page ${location.pathname}` : id, phase, actualDuration, baseDuration);
