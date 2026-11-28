import { ArrowLeft, Download, Radio } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { SiteHeader } from '@/components/SiteHeader';
import { pageMeta } from '@/lib/meta';
import { type ResolvedTheme, useResolvedTheme } from '@/lib/theme';

export const meta = () =>
  pageMeta({
    title: 'API reference',
    description:
      'Interactive OpenAPI 3.1 reference for the llama-webui HTTP API, generated directly from the shared Effect HttpApi contract.',
    path: 'developers/api/reference',
  });

/** Syncs the site's light/dark theme onto the same-origin Scalar iframe body and storage. */
function syncScalarTheme(iframe: HTMLIFrameElement | null, theme: ResolvedTheme) {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  try {
    iframe.contentWindow?.localStorage.setItem('colorMode', theme);
  } catch {
    // Private browsing or blocked storage: classes on body still apply immediately.
  }
  doc.body.classList.toggle('dark-mode', theme === 'dark');
  doc.body.classList.toggle('light-mode', theme === 'light');
}

export default function ApiReference() {
  const theme = useResolvedTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const base = import.meta.env.BASE_URL;

  useEffect(() => {
    syncScalarTheme(iframeRef.current, theme);
  }, [theme]);

  return (
    <div className="flex h-dvh flex-col bg-background">
      <SiteHeader />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-border/60 bg-background/80 px-4 py-2 text-sm sm:px-6">
        <div className="flex items-center gap-4">
          <Link
            to="/developers/api/overview/"
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            API overview
          </Link>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          <span className="font-medium text-foreground">HTTP API reference</span>
          <Link
            to="/developers/api/websocket/"
            className="hidden items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <Radio className="size-3.5" aria-hidden="true" />
            WebSocket
          </Link>
        </div>
        <a
          href={`${base}openapi.json`}
          download="llama-webui-openapi.json"
          className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Download className="size-3.5" aria-hidden="true" />
          OpenAPI 3.1 JSON
        </a>
      </div>
      <main className="min-h-0 flex-1">
        {/* oxlint-disable-next-line react/iframe-missing-sandbox -- scalar.html is our own build-generated page embedded for CSS isolation; Scalar reads window.localStorage unguarded, which throws SecurityError in an opaque sandbox */}
        <iframe
          ref={iframeRef}
          src={`${base}scalar.html`}
          title="llama-webui HTTP API reference"
          onLoad={() => syncScalarTheme(iframeRef.current, theme)}
          className="size-full border-0"
        />
      </main>
    </div>
  );
}
