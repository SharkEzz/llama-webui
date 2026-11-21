import { type ReactElement, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): unknown;
  /** Trigger element (a button); without one, the dialog is controlled through `open` / `onOpenChange`. */
  trigger?: ReactElement;
  cancelLabel?: string;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  trigger,
  cancelLabel = 'Cancel',
  ...controlled
}: ConfirmDialogProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled.open ?? ownOpen;
  const setOpen = (o: boolean) => {
    setOwnOpen(o);
    controlled.onOpenChange?.(o);
  };
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger render={trigger} />}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
