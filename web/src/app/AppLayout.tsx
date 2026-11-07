import { useEffect } from 'react';
import { Outlet, useMatch } from 'react-router';
import { AuroraBackground } from '@/components/glass/AuroraBackground';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useHealth } from '@/lib/health';
import { cn } from '@/lib/utils';
import { useWs } from '@/lib/ws';
import { PageSkeleton } from './PageSkeleton';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

/** `loading` : premier chargement d'une page (son code n'est pas encore là), la coquille avec un squelette. */
export function AppLayout({ loading = false }: { loading?: boolean }) {
  const status = useWs((s) => s.status);
  const refreshHealth = useHealth((s) => s.refresh);
  // Le chat prend toute la largeur : le fil et la liste en ont besoin.
  const wide = useMatch('/chat/*') !== null;

  // À chaque (re)connexion, on relit l'état du serveur.
  useEffect(() => {
    if (status === 'open') void refreshHealth();
  }, [status, refreshHealth]);

  return (
    <TooltipProvider>
      <AuroraBackground />
      <div className="grid h-dvh grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)]">
        <Sidebar />
        <ScrollArea className="h-dvh">
          <div
            className={cn(
              'mx-auto flex flex-col',
              wide ? 'max-w-none gap-3 px-3 pt-3 pb-3 lg:px-3' : 'max-w-6xl gap-6 px-6 pt-4 pb-10 lg:px-10',
            )}
          >
            <StatusBar />
            <main>{loading ? <PageSkeleton /> : <Outlet />}</main>
          </div>
        </ScrollArea>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
