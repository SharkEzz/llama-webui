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
 * Liste du Select, réglages du projet sur la version shadcn (components/ui reste d'origine) : ouverte sous le
 * déclencheur plutôt que par-dessus, au moins aussi large que lui, avec une marge intérieure.
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

/** Option du Select : un peu plus d'air que shadcn (py-1 pl-1.5), aligné sur le texte du déclencheur. */
export function SelectItem({ className, ...props }: ComponentProps<typeof BaseSelectItem>) {
  return <BaseSelectItem className={cn('py-1.5 pl-2', className)} {...props} />;
}
