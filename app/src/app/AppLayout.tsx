import { Profiler, useEffect } from 'react';
import { Outlet } from 'react-router';
import { AuroraBackground } from '@/components/glass/AuroraBackground';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DebugButton } from '@/features/debug/DebugButton';
import { NavigationTimer, onRender } from '@/features/debug/probes';
import { useDebugMode } from '@/lib/debug/mode';
import { useHealth } from '@/lib/health';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { useWs } from '@/lib/ws';
import { PageSkeleton } from './PageSkeleton';
import { Sidebar } from './Sidebar';
import { useSidebarLayout } from './sidebarPrefs';
import { StatusBar } from './StatusBar';

/** `loading`: first load of a page (its code is not there yet), the shell with a skeleton. */
export function AppLayout({ loading = false }: { loading?: boolean }) {
  const status = useWs((s) => s.status);
  const refreshHealth = useHealth((s) => s.refresh);
  const { collapsed } = useSidebarLayout();
  const debug = useDebugMode((s) => s.on);

  // On every (re)connect, reread the server state. A failed read of the settings is the page's to report.
  useEffect(() => {
    if (status !== 'open') return;
    void refreshHealth();
    useSettings
      .getState()
      .load()
      .catch(() => {});
  }, [status, refreshHealth]);

  return (
    <TooltipProvider>
      <AuroraBackground />
      {/* Collapsed, the sidebar column is the sidebar's margin (1rem), border (2px) and padding (1.5rem) around one
          icon row (2.5rem, see Sidebar); the width change is animated. */}
      <div
        className={cn(
          'grid h-dvh transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-cols-[calc(5rem+2px)_minmax(0,1fr)]' : 'grid-cols-[15rem_minmax(0,1fr)]',
        )}
      >
        {/* The debug window's render counts: always in the tree (adding them would remount the page), a no-op in
            production builds and while the debug mode is off. */}
        <Profiler id="sidebar" onRender={onRender}>
          <Sidebar />
        </Profiler>
        <ScrollArea className="h-dvh">
          {/* Full width; p-4 = the Sidebar margin (m-4), same gutter everywhere. Chat and logs compute their
              height from p-4 + status bar (h-10) + gap-4: 5.5rem. */}
          <div className="flex flex-col gap-4 p-4">
            <Profiler id="status bar" onRender={onRender}>
              <StatusBar />
            </Profiler>
            <main>
              <Profiler id="page" onRender={onRender}>
                {loading ? <PageSkeleton /> : <Outlet />}
              </Profiler>
            </main>
          </div>
        </ScrollArea>
      </div>
      {/* With the debug mode on, the toasts sit above its button. */}
      <Toaster position="bottom-right" {...(debug ? { offset: { bottom: '4.5rem', right: '1rem' } } : {})} />
      {!loading && <NavigationTimer />}
      <DebugButton />
    </TooltipProvider>
  );
}
