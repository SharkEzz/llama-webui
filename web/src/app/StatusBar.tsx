import { Link } from 'react-router';
import { ServerStateBadge } from '@/features/server/ServerStateBadge';
import { useHealth } from '@/lib/health';
import { useServer } from '@/lib/server';
import { cn } from '@/lib/utils';
import { useWs, WS_STATUS_UI } from '@/lib/ws';
import { ThemeToggle } from './ThemeToggle';

const DOT: Record<'ok' | 'wait' | 'down', string> = {
  ok: 'bg-success shadow-[0_0_10px] shadow-success/60',
  wait: 'bg-tone-amber animate-pulse',
  down: 'bg-destructive',
};

export function StatusBar() {
  const status = useWs((s) => s.status);
  const version = useHealth((s) => s.health?.version);
  const ui = WS_STATUS_UI[status];
  const server = useServer((s) => s.view?.state);

  return (
    <div className="flex h-10 items-center justify-end gap-4 text-sm">
      {server && status === 'open' && (
        <Link
          to="/server"
          className="mr-auto flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
          title="Voir le serveur"
        >
          <span className="text-muted-foreground">llama-server</span>
          <ServerStateBadge state={server} />
          {'profile' in server && <span className="truncate text-muted-foreground">{server.profile}</span>}
        </Link>
      )}
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <span className={cn('size-2 rounded-full', DOT[ui.tone])} aria-hidden="true" />
        <span className={cn(ui.tone === 'down' ? 'text-destructive' : 'text-muted-foreground')}>{ui.label}</span>
      </div>
      {version && (
        <span className="text-muted-foreground">
          API <span className="num text-foreground/80">{version}</span>
        </span>
      )}
      <ThemeToggle />
    </div>
  );
}
