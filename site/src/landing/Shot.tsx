import { cn } from '@/lib/utils';

/** Region of a capture, as fractions of its width (x, w) and height (y, h). Captures are 1600 × 1000. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  /** Height of the region: sets the aspect ratio. Without it, the container's own height decides. */
  h?: number;
}

const BASE = `${import.meta.env.BASE_URL}screenshots/`;
const srcSet = (name: string, theme: 'dark' | 'light') =>
  `${BASE}${name}-${theme}-800.webp 800w, ${BASE}${name}-${theme}.webp 1600w`;

interface ShotProps {
  /** Capture name in public/screenshots (site/scripts/shots.ts). */
  name: string;
  alt: string;
  crop?: Crop;
  /** Rendered width of the cropped region, for `sizes` (the full image is 1 / crop.w times wider). */
  width?: string;
  /** Fades the bottom edge out, for regions cut in the middle of the page. */
  fade?: boolean;
  className?: string;
}

/**
 * A region of an app capture, in both themes (the .dark class picks one, like ThemedImage). The image is scaled so
 * the region fills the container's width, then moved so the region's top-left corner sits at the container's.
 */
export function Shot({ name, alt, crop = { x: 0, y: 0, w: 1 }, width = '50vw', fade, className }: ShotProps) {
  const img = {
    width: 1600,
    height: 1000,
    loading: 'lazy' as const,
    decoding: 'async' as const,
    sizes: `calc(${width} / ${crop.w})`,
    style: { width: `${100 / crop.w}%`, transform: `translate(${-crop.x * 100}%, ${-crop.y * 100}%)` },
  };
  return (
    <div
      className={cn(
        'relative overflow-hidden',
        fade && 'mask-[linear-gradient(to_bottom,black_70%,transparent)]',
        className,
      )}
      style={crop.h ? { aspectRatio: `${crop.w * 1600} / ${crop.h * 1000}` } : undefined}
    >
      <img
        {...img}
        alt={alt}
        src={`${BASE}${name}-light-800.webp`}
        srcSet={srcSet(name, 'light')}
        className="absolute top-0 left-0 h-auto max-w-none dark:hidden"
      />
      <img
        {...img}
        alt={alt}
        src={`${BASE}${name}-dark-800.webp`}
        srcSet={srcSet(name, 'dark')}
        className="absolute top-0 left-0 hidden h-auto max-w-none dark:block"
      />
    </div>
  );
}
