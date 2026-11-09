import { Menu } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { NAV_LINKS, SITE } from '@/lib/site';
import { cn } from '@/lib/utils';
import { GitHubIcon } from './GitHubIcon';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-md px-3 py-1.5 text-sm transition-colors hover:text-foreground',
    isActive ? 'text-foreground' : 'text-muted-foreground',
  );

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link to="/" className="shrink-0" aria-label={`${SITE.name} home`}>
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center md:flex">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={navLinkClass}>
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
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

function MobileNav() {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open menu" />}>
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
          <a href={SITE.repo} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            GitHub
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
