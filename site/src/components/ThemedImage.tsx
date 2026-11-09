import { cn } from '@/lib/utils';

interface ThemedImageProps extends Omit<React.ComponentProps<'img'>, 'src'> {
  /** Image shown in dark mode. */
  dark: string;
  /** Image shown in light mode. */
  light: string;
  alt: string;
}

/**
 * Renders both variants and lets the .dark class pick one, so the right image shows on first paint
 * (the theme is applied before hydration and may differ from the prerendered default).
 */
export function ThemedImage({ dark, light, alt, className, ...props }: ThemedImageProps) {
  return (
    <>
      <img src={light} alt={alt} className={cn('dark:hidden', className)} {...props} />
      <img src={dark} alt={alt} className={cn('hidden dark:block', className)} {...props} />
    </>
  );
}
