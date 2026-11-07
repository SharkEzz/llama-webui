import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Préférence système « réduire les animations », suivie en direct. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const onChange = () => setReduced(m.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
