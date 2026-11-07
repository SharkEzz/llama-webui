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

/** Confirmation d'arrêt du serveur géré avant un sweep (lancement, reprise, validation) : arrêté une fois, relancé une fois. */
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
          <AlertDialogTitle>Arrêter llama-server ?</AlertDialogTitle>
          <AlertDialogDescription>
            {profile ? <>Le profil « {profile} »</> : 'Le serveur'} sera arrêté une fois pour tout le sweep, puis
            relancé avec la même commande à la fin, même en cas d'échec ou d'annulation. Le chat est indisponible
            pendant ce temps.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Arrêter et lancer
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
