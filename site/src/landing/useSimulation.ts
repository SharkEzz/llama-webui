import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createSimulation, type Frame } from './telemetry';

/**
 * Plays the telemetry simulation, one frame per second, while `running` is true. The first frame is deterministic,
 * so the prerendered HTML and the hydrated page match.
 */
export function useSimulation(running: boolean): Frame {
  const sim = useRef<ReturnType<typeof createSimulation> | null>(null);
  sim.current ??= createSimulation();
  const [frame, setFrame] = useState(() => sim.current!.frame());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setFrame(sim.current!.tick()), 1000);
    return () => clearInterval(id);
  }, [running]);

  return frame;
}

/** True while the element is at least partly on screen (IntersectionObserver). */
export function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, visible];
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const query = matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The user's reduced-motion preference (false while prerendering). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}
