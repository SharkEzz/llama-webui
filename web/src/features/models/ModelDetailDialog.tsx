import type { ModelDetail } from '@llama-webui/shared';
import { Copy, Plus } from 'lucide-react';
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

const yesNo = (b: boolean) => (b ? 'oui' : 'non');

/** Détail d'un GGUF : en-tête, répartition des poids, fichiers ; crée un profil prérempli. */
export function ModelDetailDialog({ path, onClose }: { path: string | null; onClose(): void }) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          <DialogDescription>{detail?.name || 'En-tête GGUF'}</DialogDescription>
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
                ['Quantification', detail.quant],
                ['Paramètres', formatParams(detail.params)],
                ['Couches', formatInt(detail.blockCount)],
                ['Contexte', detail.contextLength > 0 ? formatInt(detail.contextLength) : '—'],
                ['Dimension', formatInt(detail.embeddingLength)],
                ['Têtes / têtes KV', `${detail.headCount} / ${detail.headCountKv}`],
                [
                  'Experts (actifs)',
                  detail.expertCount > 0 ? `${detail.expertCount} (${detail.expertUsedCount})` : '—',
                ],
                ['Couches MTP', detail.nextnLayers > 0 ? formatInt(detail.nextnLayers) : '—'],
                ['Récurrent', yesNo(detail.recurrent)],
                ['Fenêtre glissante', detail.slidingWindow ? formatInt(detail.slidingWindow) : '—'],
                ['Modèle de chat', yesNo(detail.hasChatTemplate)],
              ]}
            />
            <div className="flex flex-col gap-4">
              <Facts
                rows={[
                  ['Embeddings', formatBytes(w.embedBytes)],
                  ['Couches (hors experts)', formatBytes(w.layersBytes)],
                  ['Experts', w.expertsBytes > 0 ? formatBytes(w.expertsBytes) : '—'],
                  ['Sortie', formatBytes(w.outputBytes)],
                  ['Autres', formatBytes(w.otherBytes)],
                  ['Total des poids', formatBytes(w.totalBytes)],
                  ['Tenseurs', formatInt(detail.tensorCount)],
                ]}
              />
              <div className="flex flex-col gap-1">
                <p className="text-sm text-muted-foreground">
                  {detail.files.length > 1 ? `${detail.files.length} fichiers` : 'Fichier'}
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
          <Button
            variant="ghost"
            disabled={!path}
            onClick={() => path && copyText(path).then(() => toast.success('Chemin copié'))}
          >
            <Copy /> Copier le chemin
          </Button>
          {detail?.kind === 'model' && (
            <Button onClick={() => navigate(`/profiles?new=1&model=${encodeURIComponent(detail.path)}`)}>
              <Plus /> Créer un profil
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
