import { cn } from '@/lib/utils';

/** The three rising bars of the brand mark (same geometry and colors as app/src/favicon.svg). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={cn('size-5', className)}>
      <rect x="2" y="11" width="4" height="7" rx="1.5" fill="#3698ff" />
      <rect x="8" y="7" width="4" height="11" rx="1.5" fill="#44d0c1" />
      <rect x="14" y="2" width="4" height="16" rx="1.5" fill="#fcb442" />
    </svg>
  );
}

/** Mark + "llama-webui" wordmark, colored like docs/assets/logo-*.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-bold tracking-tight', className)}>
      <LogoMark />
      <span>
        llama<span className="text-muted-foreground">-</span>
        <span className="text-[#3698ff]">webui</span>
      </span>
    </span>
  );
}
