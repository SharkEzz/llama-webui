import type { ModelDetail } from '@llama-webui/shared';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Facts } from '@/features/system/Facts';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { formatBytes, formatInt, formatParams } from '@/lib/format';
import { DeleteModelDialog } from './DeleteModelDialog';

const yesNo = (b: boolean) => (b ? 'yes' : 'no');

/** GGUF details: header, weight breakdown, files; creates a prefilled profile, deletes the model. */
export function ModelDetailDialog({ path, onClose }: { path: string | null; onClose(): void }) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!path) return;
    let live = true;
    api<ModelDetail>(`/models/info?path=${encodeURIComponent(path)}`).then(
      (d) => live && setDetail(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const w = detail?.weights;
  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-sm">{detail?.relPath ?? path}</DialogTitle>
          <DialogDescription>{detail?.name || 'GGUF header'}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !detail || !w ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <Facts
              rows={[
                ['Architecture', detail.arch],
                ['Quantization', detail.quant],
                ['Parameters', formatParams(detail.params)],
                ['Layers', formatInt(detail.blockCount)],
                ['Context', detail.contextLength > 0 ? formatInt(detail.contextLength) : '—'],
                ['Embedding size', formatInt(detail.embeddingLength)],
                ['Heads / KV heads', `${detail.headCount} / ${detail.headCountKv}`],
                [
                  'Experts (active)',
                  detail.expertCount > 0 ? `${detail.expertCount} (${detail.expertUsedCount})` : '—',
                ],
                ['MTP layers', detail.nextnLayers > 0 ? formatInt(detail.nextnLayers) : '—'],
                ['Recurrent', yesNo(detail.recurrent)],
                ['Sliding window', detail.slidingWindow ? formatInt(detail.slidingWindow) : '—'],
                ['Chat template', yesNo(detail.hasChatTemplate)],
              ]}
            />
            <div className="flex flex-col gap-4">
              <Facts
                rows={[
                  ['Embeddings', formatBytes(w.embedBytes)],
                  ['Layers (excluding experts)', formatBytes(w.layersBytes)],
                  ['Experts', w.expertsBytes > 0 ? formatBytes(w.expertsBytes) : '—'],
                  ['Output', formatBytes(w.outputBytes)],
                  ['Other', formatBytes(w.otherBytes)],
                  ['Total weights', formatBytes(w.totalBytes)],
                  ['Tensors', formatInt(detail.tensorCount)],
                ]}
              />
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  {detail.files.length > 1 ? `${detail.files.length} files` : 'File'}
                </p>
                {detail.files.map((f) => (
                  <p key={f} className="break-all font-mono text-xs">
                    {f}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          {path && (
            <Button variant="destructive" className="sm:mr-auto" onClick={() => setDeleting(true)}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={!path}
            onClick={() => path && copyText(path).then(() => toast.success('Path copied'))}
          >
            <Copy /> Copy path
          </Button>
          {detail?.kind === 'model' && (
            <Button onClick={() => navigate(`/profiles?new=1&model=${encodeURIComponent(detail.path)}`)}>
              <Plus /> Create profile
            </Button>
          )}
        </DialogFooter>
        {path && <DeleteModelDialog path={path} open={deleting} onOpenChange={setDeleting} onDeleted={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
