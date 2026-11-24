import { CodeXml } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { GLASS } from '@/components/glass/glass';
import { useDebugCapture } from '@/lib/debug/capture';
import { useDebugMode } from '@/lib/debug/mode';
import { cn } from '@/lib/utils';
import { useDebugWindow } from './geometry';

// The window's code is loaded when it first opens.
const DebugWindow = lazy(async () => ({ default: (await import('./DebugWindow')).DebugWindow }));

/** The debug mode's button, bottom right of every page, and the window it opens (debug mode on only). */
export function DebugButton() {
  const on = useDebugMode((s) => s.on);
  const open = useDebugWindow((s) => s.open);
  const setOpen = useDebugWindow((s) => s.setOpen);
  const unseen = useDebugCapture((s) => s.view.unseenErrors);
  if (!on) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Debug window"
        title="Debug window"
        aria-pressed={open}
        onClick={() => setOpen(!open)}
        className={cn(
          GLASS,
          'fixed right-4 bottom-4 z-40 grid size-11 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground',
          open && 'text-tone-blue',
        )}
      >
        <CodeXml className="size-5" aria-hidden="true" />
        {unseen > 0 && !open && (
          <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[0.625rem] font-semibold text-background">
            {unseen > 99 ? '99+' : unseen}
          </span>
        )}
      </button>
      {open && (
        <Suspense fallback={null}>
          <DebugWindow />
        </Suspense>
      )}
    </>
  );
}
