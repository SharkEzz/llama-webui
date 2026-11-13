import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useServer } from '@/lib/server';

/** Confirms stopping the managed server before a sweep (launch, resume, validation): stopped once, restarted once. */
export function StopServerDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  onConfirm(): void;
}) {
  const state = useServer((s) => s.view?.state);
  const profile = state && 'profile' in state ? state.profile : null;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop llama-server?</AlertDialogTitle>
          <AlertDialogDescription>
            {profile ? <>Profile “{profile}”</> : 'The server'} will be stopped once for the whole sweep, then restarted
            with the same command at the end, even if the sweep fails or is cancelled. Chat is unavailable in the
            meantime.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Stop and run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
