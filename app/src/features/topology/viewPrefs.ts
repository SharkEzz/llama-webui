import { useCallback, useState } from 'react';

/** The two drawings of the machine: a diagram of cards, and a plan of a motherboard. */
export type TopologyView = 'cards' | 'board';

export const VIEW_KEY = 'llama-webui:topology-view';

/** The view as stored by the browser; a first visit, or anything unreadable, opens the cards. */
export function parseView(raw: string | null): TopologyView {
  return raw === 'board' ? 'board' : 'cards';
}

function stored(): TopologyView {
  try {
    return parseView(localStorage.getItem(VIEW_KEY));
  } catch {
    return 'cards';
  }
}

/** The chosen view, kept by the browser from one visit to the next. */
export function useView(): [TopologyView, (view: TopologyView) => void] {
  const [view, setView] = useState(stored);
  const choose = useCallback((next: TopologyView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {}
  }, []);
  return [view, choose];
}
