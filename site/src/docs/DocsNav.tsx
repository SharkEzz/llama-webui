import { NavLink } from 'react-router';
import { href } from '@/lib/content';
import { cn } from '@/lib/utils';
import { NAV } from '../../content/nav';
import { type NavSection, sectionOf } from './nav';

/** Sidebar of the current section (Documentation or Developers), group by group. */
export function DocsNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const section: NavSection = sectionOf(NAV, pathname) ?? NAV[0]!;
  return (
    <nav aria-label={section.title} className="flex flex-col gap-7 text-sm">
      {section.groups.map((group) => (
        <div key={group.title}>
          <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">{group.title}</p>
          <ul className="flex flex-col gap-0.5">
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
        </div>
      ))}
    </nav>
  );
}
