import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * A horizontally scrollable box that joins the tab order only while its content overflows: keyboard users can then
 * scroll it with the arrow keys, and boxes that fit add no useless tab stop. Code blocks don't need it (Shiki gives
 * every <pre> a tabindex).
 */
export function HScroll({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const update = () => {
      if (box.scrollWidth > box.clientWidth) box.tabIndex = 0;
      else box.removeAttribute('tabindex');
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn('overflow-x-auto outline-none focus-visible:ring-3 focus-visible:ring-ring/50', className)}
    >
      {children}
    </div>
  );
}
