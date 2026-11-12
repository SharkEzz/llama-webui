import { Link } from 'react-router';
import { SITE } from '@/lib/site';
import { Logo } from './Logo';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Documentation', to: '/docs/' },
      { label: 'Developers', to: '/developers/' },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'GitHub', href: SITE.repo },
      { label: 'Issues', href: `${SITE.repo}/issues` },
      { label: 'MIT license', href: `${SITE.repo}/blob/master/LICENSE` },
    ],
  },
  {
    title: 'Built on',
    links: [
      { label: 'llama.cpp', href: SITE.llamaCpp },
      { label: 'Node.js', href: 'https://nodejs.org' },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[2fr_repeat(3,1fr)]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">{SITE.tagline}</p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h2 className="mb-3 text-sm font-medium">{col.title}</h2>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {col.links.map((link) => (
                <li key={link.label}>
                  {'to' in link ? (
                    <Link to={link.to} className="hover:text-foreground">
                      {link.label}
                    </Link>
                  ) : (
                    <a href={link.href} className="hover:text-foreground">
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto max-w-7xl px-4 pb-8 text-xs text-faint-foreground sm:px-6">
        © SharkEzz · MIT license · Not affiliated with the llama.cpp project.
      </div>
    </footer>
  );
}
