import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  Home,
  type LucideIcon,
  MessageSquare,
  Network,
  ScrollText,
  Server,
  Settings,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react';
import { LogoMark } from '@/components/Logo';
import { cn } from '@/lib/utils';
import { RUN } from '../telemetry';
import { StateBadge } from './DashboardReplica';

/** Same entries and icons as the app's sidebar (web/src/app/routes.ts). */
const NAV: [string, LucideIcon][] = [
  ['Home', Home],
  ['Dashboard', Activity],
  ['Server', Server],
  ['Profiles', SlidersHorizontal],
  ['Logs', ScrollText],
  ['System', Cpu],
  ['Topology', Network],
  ['Models', Boxes],
  ['Chat', MessageSquare],
  ['Benchmark', Gauge],
  ['Tuning', Wand2],
];

function NavItem({ label, icon: Icon, active }: { label: string; icon: LucideIcon; active?: boolean }) {
  return (
    <div
      className={cn(
        'relative flex h-9 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/70',
        active && 'bg-sidebar-primary/12 text-sidebar-accent-foreground',
      )}
    >
      {active && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-sidebar-primary" />}
      <Icon className={cn('size-4 shrink-0', active && 'text-sidebar-primary')} />
      <span className="hidden truncate @5xl:inline">{label}</span>
    </div>
  );
}

/**
 * The app's frame around a page: browser address bar, floating glass sidebar, status bar. Purely visual (the hero
 * describes it with a caption), so nothing in it is focusable.
 */
export function AppWindow({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container overflow-hidden rounded-xl bg-[radial-gradient(ellipse_at_top,var(--page-from),var(--page-to))] ring-1 ring-surface-border">
      <div className="flex h-10 items-center border-b border-border px-4">
        <span className="mx-auto rounded-md bg-muted px-16 py-1 text-xs text-muted-foreground @max-xl:px-6">
          127.0.0.1:7860/dashboard
        </span>
      </div>
      <div className="flex">
        <aside className="m-3 mr-0 hidden w-14 shrink-0 flex-col rounded-lg border border-sidebar-border bg-sidebar p-2 shadow-surface inset-shadow-highlight @3xl:flex @5xl:w-48 @5xl:p-3">
          <div className="flex h-10 items-center gap-2.5 px-2">
            <LogoMark />
            <span className="hidden text-[0.9375rem] font-semibold tracking-tight @5xl:inline">llama-webui</span>
          </div>
          <div className="mt-4 flex flex-1 flex-col gap-0.5">
            {NAV.map(([label, icon]) => (
              <NavItem key={label} label={label} icon={icon} active={label === 'Dashboard'} />
            ))}
          </div>
          <div className="mt-6 border-t border-sidebar-border pt-3">
            <NavItem label="Settings" icon={Settings} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 @3xl:px-5 @3xl:pt-3 @3xl:pb-5">
          <div className="flex h-8 items-center gap-4 text-sm">
            <span className="mr-auto flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">llama-server</span>
              <StateBadge />
              <span className="hidden truncate text-muted-foreground @xl:inline">{RUN.profile}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-success shadow-[0_0_10px] shadow-success/60" />
              <span className="text-muted-foreground">Connected</span>
            </span>
            <span className="hidden text-muted-foreground @3xl:inline">
              API <span className="num text-foreground/80">0.1.0</span>
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
