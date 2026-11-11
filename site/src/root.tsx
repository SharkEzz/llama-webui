import './styles/app.css';
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoLatin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { THEME_INIT_SCRIPT, useResolvedTheme } from '@/lib/theme';
import type { Route } from './+types/root';

export const links: Route.LinksFunction = () => [
  { rel: 'icon', type: 'image/svg+xml', href: `${import.meta.env.BASE_URL}favicon.svg` },
  // Both faces are on the first screen (headline, dashboard figures): fetch them alongside the stylesheet.
  { rel: 'preload', as: 'font', type: 'font/woff2', href: interLatin, crossOrigin: 'anonymous' },
  { rel: 'preload', as: 'font', type: 'font/woff2', href: monoLatin, crossOrigin: 'anonymous' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  // Prerendered as "dark"; the inline script rewrites the class before paint and the hydration render reads it back.
  const theme = useResolvedTheme();
  return (
    <html lang="en" className={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark light" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Something went wrong';
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-2xl font-semibold">{message}</h1>
      {import.meta.env.DEV && error instanceof Error && (
        <pre className="mt-6 overflow-auto rounded-md bg-well p-4 text-xs">{error.stack}</pre>
      )}
    </main>
  );
}
