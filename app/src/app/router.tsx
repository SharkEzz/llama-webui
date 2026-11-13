import type { ComponentType } from 'react';
import { createBrowserRouter } from 'react-router';
import { AppLayout } from './AppLayout';
import { MILESTONE_BY_PATH, ROUTES } from './routes';

/**
 * Each page is a chunk loaded on first visit (the initial bundle only holds the shell).
 * `load` must stay a literal import() so the bundler can split it.
 */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => ({
  // biome-ignore lint/correctness/noComponentHookFactories: the router's `lazy.Component` (loaded on demand), not a React component factory
  lazy: { Component: async () => (await load())[name] },
});

const placeholder = (title: string) => ({
  lazy: {
    // biome-ignore lint/correctness/noComponentHookFactories: the router's `lazy.Component` (loaded on demand), not a React component factory
    Component: async () => {
      const { PlaceholderPage } = await import('@/features/_placeholder/PlaceholderPage');
      return () => <PlaceholderPage title={title} />;
    },
  },
});

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    // First load of a deep URL (/bench reloaded): the shell right away, the page next.
    hydrateFallbackElement: <AppLayout loading />,
    children: [
      { index: true, ...page(() => import('@/features/home/HomePage'), 'HomePage') },
      { path: 'setup', ...page(() => import('@/features/home/HomePage'), 'SetupPage') },
      { path: 'dashboard', ...page(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage') },
      { path: 'server', ...page(() => import('@/features/server/ServerPage'), 'ServerPage') },
      { path: 'profiles', ...page(() => import('@/features/profiles/ProfilesPage'), 'ProfilesPage') },
      { path: 'logs', ...page(() => import('@/features/logs/LogsPage'), 'LogsPage') },
      { path: 'system', ...page(() => import('@/features/system/SystemPage'), 'SystemPage') },
      { path: 'topology', ...page(() => import('@/features/topology/TopologyPage'), 'TopologyPage') },
      { path: 'settings', ...page(() => import('@/features/settings/SettingsPage'), 'SettingsPage') },
      { path: 'models', ...page(() => import('@/features/models/ModelsPage'), 'ModelsPage') },
      { path: 'chat', ...page(() => import('@/features/chat/ChatPage'), 'ChatPage') },
      { path: 'chat/:id', ...page(() => import('@/features/chat/ChatPage'), 'ChatPage') },
      { path: 'bench', ...page(() => import('@/features/bench/BenchPage'), 'BenchPage') },
      { path: 'tuning', ...page(() => import('@/features/tuning/TuningPage'), 'TuningPage') },
      ...ROUTES.filter((r) => r.path in MILESTONE_BY_PATH).map((r) => ({
        path: r.path.slice(1),
        ...placeholder(r.label),
      })),
      { path: '*', ...placeholder('Page not found') },
    ],
  },
]);
