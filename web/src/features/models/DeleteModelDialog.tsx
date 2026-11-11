import type { ModelUsage } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, plural } from '@/lib/format';
import { deleteModel, modelUsage, stem, useModels } from '@/lib/models';
import { useProfiles } from '@/lib/profiles';

/**
 * Confirms deleting a model's files from the disk. When profiles use it, the user chooses whether they go too
 * (a kept profile cannot start until it gets another model).
 */
export function DeleteModelDialog({
  path,
  open,
  onOpenChange,
  onDeleted,
}: {
  path: string;
  open: boolean;
  onOpenChange(o: boolean): void;
  onDeleted(): void;
}) {
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUsage(null);
    setError(null);
    if (!open) return;
    let live = true;
    modelUsage(path).then(
      (u) => live && setUsage(u),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [open, path]);

  const run = async (deleteProfiles: boolean) => {
    setBusy(true);
    try {
      const r = await deleteModel(path, deleteProfiles);
      const n = r.deletedProfiles.length;
      toast.success(n > 0 ? `Model and ${n} ${plural(n, 'profile')} deleted` : 'Model deleted');
      onOpenChange(false);
      onDeleted();
      void useModels.getState().refresh();
      void useProfiles.getState().reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const profiles = usage?.profiles ?? [];
  const disabled = busy || !usage || usage.blocked !== null;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Delete “{stem(path)}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage
              ? `${usage.files.length > 1 ? `Its ${usage.files.length} files` : 'The file'} (${formatBytes(usage.fileBytes)}) will be permanently deleted from the disk.`
              : 'The model files will be permanently deleted from the disk.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !usage ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
              {usage.files.map((f) => (
                <p key={f} className="break-all font-mono text-xs text-muted-foreground">
                  {f}
                </p>
              ))}
            </div>
            {usage.blocked && (
              <Alert variant="destructive">
                <AlertDescription>{usage.blocked}</AlertDescription>
              </Alert>
            )}
            {profiles.length > 0 && (
              <div className="flex flex-col gap-1">
                <p>
                  {profiles.length === 1 ? 'A profile uses' : `${profiles.length} profiles use`} it. Delete{' '}
                  {plural(profiles.length, 'it', 'them')} too? A profile you keep cannot start until you pick another
                  file.
                </p>
                <ul className="list-disc pl-5">
                  {profiles.map((p) => (
                    <li key={p.id}>
                      {p.name}
                      {p.role === 'mmproj' && <span className="text-muted-foreground"> (as its projector)</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {profiles.length > 0 ? (
            <>
              <AlertDialogAction variant="outline" disabled={disabled} onClick={() => void run(false)}>
                Delete model only
              </AlertDialogAction>
              <AlertDialogAction variant="destructive" disabled={disabled} onClick={() => void run(true)}>
                Delete model and {profiles.length} {plural(profiles.length, 'profile')}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction variant="destructive" disabled={disabled} onClick={() => void run(false)}>
              Delete
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
