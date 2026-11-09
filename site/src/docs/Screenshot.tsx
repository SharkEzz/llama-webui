import { type Crop, Shot } from '@/components/Shot';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

/**
 * A capture of the app (site/public/screenshots, both themes), optionally cropped, that opens full size on click.
 * <Screenshot name="dashboard" alt="…" caption="…" />
 */
export function Screenshot({ name, alt, caption, crop }: { name: string; alt: string; caption?: string; crop?: Crop }) {
  return (
    <figure className="not-prose my-8">
      <Dialog>
        <DialogTrigger
          render={
            <button
              type="button"
              aria-label={`Enlarge: ${alt}`}
              className="block w-full cursor-zoom-in overflow-hidden rounded-xl shadow-surface ring-1 ring-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <Shot name={name} alt={alt} crop={crop ?? { x: 0, y: 0, w: 1, h: 1 }} width="min(46rem, 92vw)" />
        </DialogTrigger>
        <DialogContent className="w-[min(96vw,100rem)] max-w-none p-1.5 sm:max-w-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <Shot name={name} alt={alt} width="96vw" className="rounded-lg" />
        </DialogContent>
      </Dialog>
      {caption && <figcaption className="mt-3 text-center text-sm text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
