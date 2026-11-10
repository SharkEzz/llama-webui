import { create } from 'zustand';
import { useMediaQuery } from '@/lib/useMediaQuery';

const KEY = 'llama-webui:sidebar';

/** Sidebar state as stored by the browser; anything else than "collapsed" means expanded. */
export function parseCollapsed(raw: string | null): boolean {
  return raw === 'collapsed';
}

function stored(): boolean {
  try {
    return parseCollapsed(localStorage.getItem(KEY));
  } catch {
    return false;
  }
}

interface SidebarState {
  /** The user's choice, kept by the browser from one visit to the next. */
  collapsed: boolean;
  toggle(): void;
}

export const useSidebar = create<SidebarState>((set, get) => ({
  collapsed: stored(),
  toggle() {
    const collapsed = !get().collapsed;
    try {
      localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {}
    set({ collapsed });
  },
}));

/**
 * `narrow`: below Tailwind's md, where the labels do not fit and the sidebar is icons only whatever the choice.
 * `collapsed`: what the layout shows.
 */
export function useSidebarLayout(): { collapsed: boolean; narrow: boolean } {
  const chosen = useSidebar((s) => s.collapsed);
  const narrow = !useMediaQuery('(min-width: 48rem)');
  return { collapsed: chosen || narrow, narrow };
}
