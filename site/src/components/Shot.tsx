import { cn } from '@/lib/utils';

/** Region of a capture, as fractions of its width (x, w) and height (y, h). Captures are 1600 × 1000 unless sized. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  /** Height of the region: sets the aspect ratio. Without it, the container's own height decides. */
  h?: number;
}

const BASE = `${import.meta.env.BASE_URL}screenshots/`;
const srcSet = (name: string, theme: 'dark' | 'light', width: number) =>
  `${BASE}${name}-${theme}-800.webp 800w, ${BASE}${name}-${theme}.webp ${width}w`;

interface ShotProps {
  /** Capture name in public/screenshots (site/scripts/shots.ts). */
  name: string;
  alt: string;
  crop?: Crop;
  /** Rendered width of the cropped region, for `sizes` (the full image is 1 / crop.w times wider). */
  width?: string;
  /** Fades the bottom edge out, for regions cut in the middle of the page. */
  fade?: boolean;
  /** Size of the capture, when it is not a whole window (an animation of a region, shots.ts `animation.clip`). */
  size?: { width: number; height: number };
  className?: string;
}

/** The size of a capture of the whole window. */
const WINDOW = { width: 1600, height: 1000 };

/** The whole capture. */
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

/**
 * A region of an app capture, in both themes (the .dark class picks one, like ThemedImage). The image is scaled so
 * the region fills the container's width, then moved so the region's top-left corner sits at the container's.
 */
export function Shot({ name, alt, crop = FULL, width = '50vw', fade, size = WINDOW, className }: ShotProps) {
  const img = {
    width: size.width,
    height: size.height,
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
      style={crop.h ? { aspectRatio: `${crop.w * size.width} / ${crop.h * size.height}` } : undefined}
    >
      <img
        {...img}
        alt={alt}
        src={`${BASE}${name}-light-800.webp`}
        srcSet={srcSet(name, 'light', size.width)}
        className="absolute top-0 left-0 h-auto max-w-none dark:hidden"
      />
      <img
        {...img}
        alt={alt}
        src={`${BASE}${name}-dark-800.webp`}
        srcSet={srcSet(name, 'dark', size.width)}
        className="absolute top-0 left-0 hidden h-auto max-w-none dark:block"
      />
    </div>
  );
}
