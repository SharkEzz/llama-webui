import type { ModelUsage } from '@llama-webui/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, plural } from '@/lib/format';
import { deleteModel, modelUsage, useModels } from '@/lib/models';
import { useProfiles } from '@/lib/profiles';
import { stem } from '@/lib/stem';

/**
 * Delete button of a model, confirmed in a popover that lists the files and the profiles using it: the user chooses
 * whether those profiles go too (a kept profile cannot start until it gets another model).
 */
export function DeleteModelPopover({ path, onDeleted }: { path: string; onDeleted(): void }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setUsage(null);
    setError(null);
    modelUsage(path).then(setUsage, (e: Error) => setError(e.message));
  };

  const run = async (deleteProfiles: boolean) => {
    setBusy(true);
    try {
      const r = await deleteModel(path, deleteProfiles);
      const n = r.deletedProfiles.length;
      toast.success(n > 0 ? `Model and ${n} ${plural(n, 'profile')} deleted` : 'Model deleted');
      setOpen(false);
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
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button variant="destructive" className="sm:mr-auto" />}>
        <Trash2 /> Delete
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[26rem] max-w-[calc(100vw-2rem)]">
        <PopoverHeader>
          <PopoverTitle className="break-all">Delete “{stem(path)}”?</PopoverTitle>
          <PopoverDescription>
            {usage
              ? `${usage.files.length > 1 ? `Its ${usage.files.length} files` : 'The file'} (${formatBytes(usage.fileBytes)}) will be permanently deleted from the disk.`
              : 'The model files will be permanently deleted from the disk.'}
          </PopoverDescription>
        </PopoverHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !usage ? (
          <Skeleton className="h-12" />
        ) : (
          <>
            {usage.files.length > 1 && (
              <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
                {usage.files.map((f) => (
                  <p key={f} className="break-all font-mono text-xs text-muted-foreground">
                    {f.split('/').pop()}
                  </p>
                ))}
              </div>
            )}
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
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {profiles.length > 0 ? (
            <>
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run(false)}>
                Delete model only
              </Button>
              <Button variant="destructive" size="sm" disabled={disabled} onClick={() => void run(true)}>
                Delete model and {profiles.length} {plural(profiles.length, 'profile')}
              </Button>
            </>
          ) : (
            <Button variant="destructive" size="sm" disabled={disabled} onClick={() => void run(false)}>
              Delete
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
