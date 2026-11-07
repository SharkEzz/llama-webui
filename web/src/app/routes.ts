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

export const ROUTES = [
  { path: '/', label: 'Home', icon: Home },
  { path: '/dashboard', label: 'Dashboard', icon: Activity },
  { path: '/server', label: 'Server', icon: Server },
  { path: '/profiles', label: 'Profiles', icon: SlidersHorizontal },
  { path: '/logs', label: 'Logs', icon: ScrollText },
  { path: '/system', label: 'System', icon: Cpu },
  { path: '/topology', label: 'Topology', icon: Network },
  { path: '/models', label: 'Models', icon: Boxes },
  { path: '/chat', label: 'Chat', icon: MessageSquare },
  { path: '/bench', label: 'Benchmark', icon: Gauge },
  { path: '/tuning', label: 'Tuning', icon: Wand2 },
  { path: '/settings', label: 'Settings', icon: Settings },
] as const;

export type AppRoute = (typeof ROUTES)[number];

/** Milestone that will deliver each still-empty page. */
export const MILESTONE_BY_PATH: Record<string, string> = {};
