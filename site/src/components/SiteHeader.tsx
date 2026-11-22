import { Menu, Search } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { NAV_LINKS, SITE } from '@/lib/site';
import { cn } from '@/lib/utils';
import { GitHubIcon } from './GitHubIcon';
import { Logo } from './Logo';
import { SearchDialog } from './SearchDialog';
import { ThemeToggle } from './ThemeToggle';

const HOME_ANCHORS = [
  { label: 'Monitoring', href: '#monitoring' },
  { label: 'Tuning', href: '#tuning' },
  { label: 'Benchmark', href: '#benchmark' },
  { label: 'Models & Chat', href: '#profiles' },
] as const;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-full px-3 py-1.5 text-sm transition-colors hover:bg-muted/80 hover:text-foreground',
    isActive ? 'bg-muted/70 text-foreground' : 'text-muted-foreground',
  );

export function SiteHeader() {
  const { pathname } = useLocation();
  const isHome = pathname === '/' || pathname === '';

  return (
    <header className="sticky top-3 z-40 mx-auto max-w-5xl px-3 sm:px-6">
      <div className="flex h-13 items-center gap-3 rounded-full border border-surface-border-bright bg-surface-strong px-2.5 pl-4 shadow-surface inset-shadow-highlight backdrop-blur-2xl backdrop-saturate-150">
        <Link to="/" className="shrink-0" aria-label={`${SITE.name} home`}>
          <Logo />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-0.5 md:flex">
          {isHome &&
            HOME_ANCHORS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="hidden rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground lg:inline-flex"
              >
                {item.label}
              </a>
            ))}
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={navLinkClass}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <SearchButton />
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            nativeButton={false}
            render={<a href={SITE.repo} aria-label="llama-webui on GitHub" />}
          >
            <GitHubIcon className="size-4" />
          </Button>
          <ThemeToggle />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

// The user agent never changes: nothing to subscribe to
const noSubscription = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
// The prerendered page, and the hydration that must match it, know no user agent
const notMac = () => false;

/** Opens the documentation search; ⌘K / Ctrl+K and "/" open it from anywhere. */
function SearchButton() {
  const [open, setOpen] = useState(false);
  const mac = useSyncExternalStore(noSubscription, isMac, notMac);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search the documentation"
        className="mr-0.5 flex h-8 items-center gap-2 rounded-full border border-border bg-well px-3 text-sm text-muted-foreground transition-colors hover:border-surface-border-bright hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-sm:w-8 max-sm:justify-center max-sm:px-0"
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="max-sm:hidden">Search</span>
        <kbd className="ml-2 rounded-md border border-border bg-muted/60 px-1.5 font-mono text-[11px] max-sm:hidden">
          {mac ? '⌘' : 'Ctrl'} K
        </kbd>
      </button>
      <SearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function MobileNav() {
  return (
    <Sheet>
      <SheetTrigger
        render={<Button variant="ghost" size="icon-sm" className="rounded-full md:hidden" aria-label="Open menu" />}
      >
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className="w-72">
        <SheetHeader>
          <SheetTitle>
            <Logo />
          </SheetTitle>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={navLinkClass}>
              {link.label}
            </NavLink>
          ))}
          <a href={SITE.repo} className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            GitHub
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
