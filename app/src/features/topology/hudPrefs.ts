import { Predicate } from 'effect';
import { useCallback, useState } from 'react';

/** The cards laid over the scene that fold down to their title line, to give the scene more room. */
export type HudCard = 'phase' | 'model';
export type Collapsed = Record<HudCard, boolean>;

const KEY = 'llama-webui:topology-hud';

/** Folded cards as stored by the browser; anything unreadable means every card open. */
export function parseCollapsed(raw: string | null): Collapsed {
  let v: unknown = null;
  try {
    v = raw === null ? null : JSON.parse(raw);
  } catch {}
  const folded = (card: HudCard) => Predicate.hasProperty(v, card) && v[card] === true;
  return { phase: folded('phase'), model: folded('model') };
}

function stored(): Collapsed {
  try {
    return parseCollapsed(localStorage.getItem(KEY));
  } catch {
    return parseCollapsed(null);
  }
}

/** Folded state of the cards, kept by the browser from one visit to the next. */
export function useCollapsed(): [Collapsed, (card: HudCard) => void] {
  const [collapsed, setCollapsed] = useState(stored);
  // The write happens once per toggle, outside the updater (which React may run twice)
  const toggle = useCallback(
    (card: HudCard) => {
      const next = { ...collapsed, [card]: !collapsed[card] };
      setCollapsed(next);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
    },
    [collapsed],
  );
  return [collapsed, toggle];
}
