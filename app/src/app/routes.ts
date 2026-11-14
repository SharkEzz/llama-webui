import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  Home,
  MessageSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react';

/**
 * Sidebar entries, in order. The sidebar draws a line between two groups, so a group's entries must follow each
 * other; `settings` is pinned at the bottom.
 */
export const ROUTES = [
  { path: '/', label: 'Home', icon: Home, group: 'overview' },
  { path: '/dashboard', label: 'Dashboard', icon: Activity, group: 'overview' },
  { path: '/models', label: 'Models', icon: Boxes, group: 'run' },
  { path: '/profiles', label: 'Profiles', icon: SlidersHorizontal, group: 'run' },
  { path: '/server', label: 'Server', icon: Server, group: 'run' },
  { path: '/chat', label: 'Chat', icon: MessageSquare, group: 'run' },
  { path: '/system', label: 'System', icon: Cpu, group: 'monitor' },
  { path: '/topology', label: 'Topology', icon: Network, group: 'monitor' },
  { path: '/logs', label: 'Logs', icon: ScrollText, group: 'monitor' },
  { path: '/bench', label: 'Benchmark', icon: Gauge, group: 'tune' },
  { path: '/tuning', label: 'Tuning', icon: Wand2, group: 'tune' },
  { path: '/settings', label: 'Settings', icon: Settings, group: 'settings' },
] as const;

export type AppRoute = (typeof ROUTES)[number];
export type NavGroup = AppRoute['group'];

/** Consecutive entries of the same group, in order. */
export function navGroups<R extends { group: string }>(routes: readonly R[]): R[][] {
  const groups: R[][] = [];
  for (const route of routes) {
    const last = groups.at(-1);
    if (last?.[0]?.group === route.group) last.push(route);
    else groups.push([route]);
  }
  return groups;
}

/** The milestone of the Effect server rewrite that brings each page back; until then, it shows a waiting page. */
export const MILESTONE_BY_PATH: Record<string, string> = {
  '/': 'E3',
  '/dashboard': 'E4',
  '/models': 'E6',
  '/profiles': 'E2',
  '/server': 'E3',
  '/chat': 'E5',
  '/system': 'E4',
  '/topology': 'E4',
  '/logs': 'E3',
  '/bench': 'E7',
  '/tuning': 'E8',
  '/settings': 'E1',
};
