import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ComponentProps, Fragment } from 'react';
import { NavLink } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type AppRoute, navGroups, ROUTES } from './routes';
import { useSidebar, useSidebarLayout } from './sidebarPrefs';

const main = navGroups(ROUTES.filter((r) => r.group !== 'settings'));
const settings = ROUTES.find((r) => r.group === 'settings')!;

/**
 * One row. Collapsed, the sidebar is exactly as wide as a row's padding and icon (2.5rem inside its own padding):
 * the icons do not move between the two states, and a label, which starts right where the row ends, is clipped
 * rather than removed. It stays the row's accessible name and is revealed as the sidebar widens.
 */
const ROW =
  'group relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-md px-3 text-sm transition-colors text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
const LABEL = 'overflow-hidden whitespace-nowrap';

/** The row's name beside the sidebar, only while its label is clipped. */
function RowTooltip({
  label,
  show,
  children,
}: {
  label: string;
  show: boolean;
  children: ComponentProps<typeof TooltipTrigger>['render'];
}) {
  return (
    <Tooltip disabled={!show}>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={16}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Item({ route, collapsed }: { route: AppRoute; collapsed: boolean }) {
  const Icon = route.icon;
  return (
    <RowTooltip label={route.label} show={collapsed}>
      <NavLink
        to={route.path}
        end={route.path === '/'}
        className={({ isActive }) =>
          cn(ROW, isActive && 'bg-sidebar-primary/12 text-sidebar-accent-foreground hover:bg-sidebar-primary/15')
        }
      >
        {({ isActive }) => (
          <>
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-sidebar-primary transition-opacity',
                isActive ? 'opacity-100' : 'opacity-0',
              )}
            />
            <Icon className={cn('size-4 shrink-0', isActive && 'text-sidebar-primary')} aria-hidden="true" />
            <span className={LABEL}>{route.label}</span>
          </>
        )}
      </NavLink>
    </RowTooltip>
  );
}

export function Sidebar() {
  const { collapsed, narrow } = useSidebarLayout();
  const toggle = useSidebar((s) => s.toggle);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <aside className="sticky top-4 m-4 mr-0 flex h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar p-3 text-sidebar-foreground shadow-surface inset-shadow-highlight backdrop-blur-(--surface-blur)">
      <div className="flex h-10 items-center gap-2.5 overflow-hidden px-2.5">
        <LlamaMark />
        <span className={cn(LABEL, 'text-[0.9375rem] font-semibold tracking-tight')}>llama-webui</span>
      </div>
      <nav id="main-navigation" aria-label="Main navigation" className="mt-4 flex flex-1 flex-col gap-0.5">
        {main.map((group, i) => (
          <Fragment key={group[0]!.group}>
            {/* Centered under the icons, so it reads the same collapsed and expanded. */}
            {i > 0 && <div aria-hidden="true" className="mx-2 my-2 h-px shrink-0 bg-sidebar-border" />}
            {group.map((r) => (
              <Item key={r.path} route={r} collapsed={collapsed} />
            ))}
          </Fragment>
        ))}
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-sidebar-border pt-3">
        {/* A narrow window has no room for the labels: nothing to expand to. */}
        {!narrow && (
          <RowTooltip label={toggleLabel} show={collapsed}>
            <button
              type="button"
              onClick={toggle}
              aria-label={toggleLabel}
              aria-expanded={!collapsed}
              aria-controls="main-navigation"
              className={ROW}
            >
              <ToggleIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className={LABEL}>Collapse</span>
            </button>
          </RowTooltip>
        )}
        <Item route={settings} collapsed={collapsed} />
      </div>
    </aside>
  );
}

/** Monogram: three bars of increasing height, like rising throughput. */
function LlamaMark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden="true">
      <rect x="2" y="11" width="4" height="7" rx="1.5" fill="var(--tone-blue)" />
      <rect x="8" y="7" width="4" height="11" rx="1.5" fill="var(--tone-teal)" />
      <rect x="14" y="2" width="4" height="16" rx="1.5" fill="var(--tone-amber)" />
    </svg>
  );
}
