import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppLayout } from './AppLayout';
import { type AppRoute, MILESTONE_BY_PATH, ROUTES } from './routes';

/**
 * A page of the menu that the Effect server does not serve yet: the waiting page, loaded on first visit (the initial
 * bundle only holds the shell). Each page comes back by being routed again at its milestone.
 */
const placeholder = (title: string, milestone?: string) => ({
  lazy: {
    // biome-ignore lint/correctness/noComponentHookFactories: the router's `lazy.Component` (loaded on demand), not a React component factory
    Component: async () => {
      const { PlaceholderPage } = await import('@/features/_placeholder/PlaceholderPage');
      return () => <PlaceholderPage title={title} milestone={milestone} />;
    },
  },
});

const chatPage = async () => (await import('@/features/chat/ChatPage')).ChatPage;

/** The pages the Effect server serves again, each loaded on first visit. */
const PORTED: Partial<Record<string, () => Promise<ComponentType>>> = {
  '/dashboard': async () => (await import('@/features/dashboard/DashboardPage')).DashboardPage,
  '/system': async () => (await import('@/features/system/SystemPage')).SystemPage,
  '/topology': async () => (await import('@/features/topology/TopologyPage')).TopologyPage,
  '/settings': async () => (await import('@/features/settings/SettingsPage')).SettingsPage,
  '/profiles': async () => (await import('@/features/profiles/ProfilesPage')).ProfilesPage,
  '/server': async () => (await import('@/features/server/ServerPage')).ServerPage,
  '/logs': async () => (await import('@/features/logs/LogsPage')).LogsPage,
  '/chat': chatPage,
};

const pageOf = (r: AppRoute) => {
  const Component = PORTED[r.path];
  return Component ? { lazy: { Component } } : placeholder(r.label, MILESTONE_BY_PATH[r.path]);
};

const pages: RouteObject[] = ROUTES.map((r) =>
  r.path === '/' ? { index: true, ...pageOf(r) } : { path: r.path.slice(1), ...pageOf(r) },
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    // First load of a deep URL (/bench reloaded): the shell right away, the page next.
    hydrateFallbackElement: <AppLayout loading />,
    children: [
      ...pages,
      { path: 'setup', ...placeholder('Setup', MILESTONE_BY_PATH['/']) },
      { path: 'chat/:id', lazy: { Component: chatPage } },
      { path: '*', ...placeholder('Page not found') },
    ],
  },
]);
