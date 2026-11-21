import type { ComponentProps } from 'react';
import { SelectContent as BaseSelectContent, SelectItem as BaseSelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export {
  Select,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Select list with the project's tweaks over the shadcn version (components/ui stays stock): opens below the
 * trigger rather than over it, at least as wide as it, with inner padding.
 */
export function SelectContent({
  className,
  alignItemWithTrigger = false,
  ...props
}: ComponentProps<typeof BaseSelectContent>) {
  return (
    <BaseSelectContent
      alignItemWithTrigger={alignItemWithTrigger}
      align="start"
      className={cn('w-auto min-w-(--anchor-width) p-1', className)}
      {...props}
    />
  );
}

/** Select option: a bit roomier than shadcn (py-1 pl-1.5), aligned with the trigger text. */
export function SelectItem({ className, ...props }: ComponentProps<typeof BaseSelectItem>) {
  return <BaseSelectItem className={cn('py-1.5 pl-2', className)} {...props} />;
}
