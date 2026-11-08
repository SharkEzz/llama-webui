import { ChevronRight } from 'lucide-react';
import { NavLink } from 'react-router';
import { href } from '@/lib/content';
import { cn } from '@/lib/utils';
import { NAV } from '../../content/nav';
import { type NavSection, sectionOf } from './nav';

/**
 * Sidebar of the current section (Documentation or Developers). Each group is a native <details>, open by default:
 * collapsing works without JavaScript and survives client-side navigation (React does not reset `open` on re-render).
 */
export function DocsNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const section: NavSection = sectionOf(NAV, pathname) ?? NAV[0]!;
  return (
    <nav aria-label={section.title} className="flex flex-col gap-4 text-sm">
      {section.groups.map((group) => (
        <details key={group.title} open className="group/group">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            {group.title}
            <ChevronRight
              className="size-3.5 transition-transform group-open/group:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {group.pages.map((page) => (
              <li key={page.path}>
                <NavLink
                  to={href(page.path)}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'relative block rounded-md px-3 py-1.5 transition-colors',
                      isActive
                        ? 'bg-primary/10 font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary-ink'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  {page.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  );
}
