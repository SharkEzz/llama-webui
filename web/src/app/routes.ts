import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  Home,
  MessageSquare,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react';

export const ROUTES = [
  { path: '/', label: 'Accueil', icon: Home },
  { path: '/dashboard', label: 'Dashboard', icon: Activity },
  { path: '/server', label: 'Serveur', icon: Server },
  { path: '/profiles', label: 'Profils', icon: SlidersHorizontal },
  { path: '/logs', label: 'Logs', icon: ScrollText },
  { path: '/system', label: 'Système', icon: Cpu },
  { path: '/models', label: 'Modèles', icon: Boxes },
  { path: '/chat', label: 'Chat', icon: MessageSquare },
  { path: '/bench', label: 'Benchmark', icon: Gauge },
  { path: '/tuning', label: 'Tuning', icon: Wand2 },
  { path: '/settings', label: 'Réglages', icon: Settings },
] as const;

export type AppRoute = (typeof ROUTES)[number];

/** Jalon qui livrera chaque page encore vide. */
export const MILESTONE_BY_PATH: Record<string, string> = {};
