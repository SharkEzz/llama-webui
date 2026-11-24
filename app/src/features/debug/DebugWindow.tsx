import { Dialog } from '@base-ui/react/dialog';
import { CodeXml, Eraser, Pause, Play, X } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect } from 'react';
import { GLASS } from '@/components/glass/glass';
import { GlassCard } from '@/components/glass/GlassCard';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clearCapture, markErrorsSeen, setPaused, useDebugCapture } from '@/lib/debug/capture';
import { cn } from '@/lib/utils';
import { HttpPanel, SsePanel } from './ApiPanels';
import { DRAG_START, type DragKind, dragRect, useDebugWindow } from './geometry';
import { PerfPanel } from './PerfPanel';
import { WsPanel } from './WsPanel';

/** Follows the pointer from a press until its release: the window moves or resizes, and is stored at the end. */
function startDrag(e: ReactPointerEvent, kind: DragKind) {
  const start = useDebugWindow.getState().rect;
  if (!start || e.button !== 0) return;
  e.preventDefault();
  const { clientX: x0, clientY: y0 } = e;
  // Resizing starts at once; moving after a few pixels, so a click on the header stays a click.
  let dragging = kind !== 'move';
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!dragging && Math.hypot(dx, dy) < DRAG_START) return;
    dragging = true;
    useDebugWindow.getState().setRect(dragRect(start, kind, dx, dy));
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    const rect = useDebugWindow.getState().rect;
    if (dragging && rect) useDebugWindow.getState().setRect(rect, true);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/** A press on the card's header, outside of its buttons, moves the window. */
function onHeaderPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
  if (!(e.target instanceof Element)) return;
  if (!e.target.closest('[data-slot=card-header]') || e.target.closest('button')) return;
  startDrag(e, 'move');
}

const HANDLES = ['right', 'bottom', 'corner'] as const;
const HANDLE: Record<(typeof HANDLES)[number], string> = {
  right: 'top-14 right-0 bottom-3 w-2 cursor-ew-resize',
  bottom: 'right-3 bottom-0 left-0 h-2 cursor-ns-resize',
  corner: 'right-0 bottom-0 size-4 cursor-nwse-resize',
};

/**
 * The debug window: not modal (the page stays usable, a click beside it does not close it), moved by its header,
 * resized by its right and bottom edges. Kept open from one page to the next, closed by its button or Escape.
 */
export function DebugWindow() {
  const rect = useDebugWindow((s) => s.rect);
  const setOpen = useDebugWindow((s) => s.setOpen);
  const paused = useDebugCapture((s) => s.paused);
  const unseen = useDebugCapture((s) => s.view.unseenErrors);

  // The viewport shrinks: the window stays on screen.
  useEffect(() => {
    const onResize = () => {
      const { rect: r, setRect } = useDebugWindow.getState();
      if (r) setRect(r);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Open, the window shows the errors: the button's badge does not count them.
  useEffect(() => {
    if (unseen > 0) markErrorsSeen();
  }, [unseen]);

  if (!rect) return null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && setOpen(false)} modal={false} disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Popup
          aria-label="Debug"
          className="fixed z-50 flex outline-none"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          onPointerDown={onHeaderPointerDown}
        >
          <GlassCard
            title="Debug"
            icon={CodeXml}
            className="flex min-h-0 w-full flex-col overflow-hidden [&_[data-slot=card-header]]:cursor-move [&_[data-slot=card-header]]:select-none"
            contentClassName="flex min-h-0 flex-1 flex-col"
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={paused ? 'Resume' : 'Pause'}
                  title={paused ? 'Resume' : 'Pause'}
                  aria-pressed={paused}
                  onClick={() => setPaused(!paused)}
                >
                  {paused ? <Play /> : <Pause />}
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Clear" title="Clear" onClick={clearCapture}>
                  <Eraser />
                </Button>
                <Dialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" />}>
                  <X />
                </Dialog.Close>
              </>
            }
          >
            <Tabs defaultValue="ws" className="flex min-h-0 flex-1 flex-col">
              <TabsList className={cn(GLASS, 'h-8 shrink-0 p-1 *:px-2.5')}>
                <TabsTrigger value="ws">WebSocket</TabsTrigger>
                <TabsTrigger value="http">HTTP</TabsTrigger>
                <TabsTrigger value="sse">SSE</TabsTrigger>
                <TabsTrigger value="perf">Performance</TabsTrigger>
              </TabsList>
              <TabsContent value="ws" className="min-h-0 flex-1 overflow-auto">
                <WsPanel />
              </TabsContent>
              <TabsContent value="http" className="min-h-0 flex-1 overflow-auto">
                <HttpPanel />
              </TabsContent>
              <TabsContent value="sse" className="min-h-0 flex-1 overflow-auto">
                <SsePanel />
              </TabsContent>
              <TabsContent value="perf" className="min-h-0 flex-1 overflow-auto">
                <PerfPanel />
              </TabsContent>
            </Tabs>
          </GlassCard>
          {HANDLES.map((kind) => (
            <div
              key={kind}
              aria-hidden="true"
              className={cn('absolute touch-none', HANDLE[kind])}
              onPointerDown={(e) => startDrag(e, kind)}
            />
          ))}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
