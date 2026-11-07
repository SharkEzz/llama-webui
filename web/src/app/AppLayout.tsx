import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { AuroraBackground } from '@/components/glass/AuroraBackground';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useHealth } from '@/lib/health';
import { useWs } from '@/lib/ws';
import { PageSkeleton } from './PageSkeleton';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

/** `loading`: first load of a page (its code is not there yet), the shell with a skeleton. */
export function AppLayout({ loading = false }: { loading?: boolean }) {
  const status = useWs((s) => s.status);
  const refreshHealth = useHealth((s) => s.refresh);

  // On every (re)connect, reread the server state.
  useEffect(() => {
    if (status === 'open') void refreshHealth();
  }, [status, refreshHealth]);

  return (
    <TooltipProvider>
      <AuroraBackground />
      <div className="grid h-dvh grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)]">
        <Sidebar />
        <ScrollArea className="h-dvh">
          {/* Full width; p-4 = the Sidebar margin (m-4), same gutter everywhere. Chat and logs compute their
              height from p-4 + status bar (h-10) + gap-4: 5.5rem. */}
          <div className="flex flex-col gap-4 p-4">
            <StatusBar />
            <main>{loading ? <PageSkeleton /> : <Outlet />}</main>
          </div>
        </ScrollArea>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
