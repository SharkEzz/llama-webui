import type { ModelEntry } from '@llama-webui/shared';
import { Boxes, Download, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { GlassCard } from '@/components/glass/GlassCard';
import { GLASS } from '@/components/glass/glass';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queueProgress, useDownloads } from '@/lib/downloads';
import { formatBytes, formatInt, formatParams, formatPct } from '@/lib/format';
import { useModels } from '@/lib/models';
import { cn } from '@/lib/utils';
import { DownloadSheet } from './hf/DownloadSheet';
import { ModelDetailDialog } from './ModelDetailDialog';

type KindFilter = 'model' | 'mmproj' | 'all';

const matches = (m: ModelEntry, q: string) =>
  !q || [m.relPath, ...(m.ok ? [m.name, m.arch, m.quant] : [])].some((s) => s.toLowerCase().includes(q));

/** The GGUFs of the models folder, with their header metadata. */
export function ModelsPage() {
  const { list, error, loading, refresh } = useModels();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('model');
  // Detail dialog in the URL (`?open=<path>`): the “Details” action of a finished download opens it.
  const [params, setParams] = useSearchParams();
  const open = params.get('open');
  const setOpen = (path: string | null) => setParams(path ? { open: path } : {}, { replace: true });
  const [sheet, setSheet] = useState(false);
  const progress = useDownloads((s) => queueProgress(s.items, s.live));
  useEffect(() => void refresh(), [refresh]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => (list?.models ?? []).filter((m) => (kind === 'all' || !m.ok || m.kind === kind) && matches(m, q)),
    [list, kind, q],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Models</h1>
          {list && <p className="font-mono text-sm text-muted-foreground">{list.dir}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setSheet(true)}>
            <Download /> Download
            {progress !== null && <span className="num text-muted-foreground">· {formatPct(progress * 100)}</span>}
          </Button>
          <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} /> Rescan
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className={GLASS}>
          <AlertTitle>Scan failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!list ? (
        !error && <Skeleton className="h-64" />
      ) : list.models.length === 0 ? (
        <Alert className={GLASS}>
          <Boxes />
          <AlertTitle>No GGUF files in {list.setting}</AlertTitle>
          <AlertDescription>
            <p>
              <button type="button" className="underline underline-offset-4" onClick={() => setSheet(true)}>
                Download one from Hugging Face
              </button>
              , put models in this folder or change it in{' '}
              <Link to="/settings" className="underline underline-offset-4">
                Settings
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <GlassCard>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <InputGroup className="max-w-sm">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="File, name, architecture, quantization"
                />
              </InputGroup>
              <Tabs value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
                <TabsList className="h-9 p-1 *:px-3">
                  <TabsTrigger value="model">Models</TabsTrigger>
                  <TabsTrigger value="mmproj">Projectors</TabsTrigger>
                  <TabsTrigger value="all">All</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matching files.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Arch</TableHead>
                    <TableHead>Quant</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Parameters</TableHead>
                    <TableHead className="text-right">Layers</TableHead>
                    <TableHead className="text-right">Context</TableHead>
                    <TableHead className="text-right">Experts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow
                      key={m.path}
                      className={cn(m.ok && 'cursor-pointer')}
                      onClick={() => m.ok && setOpen(m.path)}
                    >
                      <TableCell className="max-w-md">
                        <div className="truncate font-mono text-xs">{m.relPath}</div>
                        {m.ok && m.name && <div className="truncate text-xs text-muted-foreground">{m.name}</div>}
                      </TableCell>
                      {m.ok ? (
                        <>
                          <TableCell>{m.arch}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{m.quant}</Badge>
                          </TableCell>
                          <TableCell className="num text-right">{formatBytes(m.fileBytes)}</TableCell>
                          <TableCell className="num text-right">{formatParams(m.params)}</TableCell>
                          <TableCell className="num text-right">{formatInt(m.blockCount)}</TableCell>
                          <TableCell className="num text-right">
                            {m.contextLength > 0 ? formatInt(m.contextLength) : '—'}
                          </TableCell>
                          <TableCell className="num text-right">
                            {m.expertCount > 0 ? `${m.expertCount} / ${m.expertUsedCount}` : '—'}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell colSpan={7}>
                          <Badge variant="destructive">unreadable</Badge>
                          <span className="ml-2 text-xs text-muted-foreground">{m.error}</span>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </GlassCard>
      )}
      <ModelDetailDialog path={open} onClose={() => setOpen(null)} />
      <DownloadSheet
        open={sheet}
        onOpenChange={setSheet}
        onShow={(path) => {
          setSheet(false);
          setOpen(path);
        }}
      />
    </div>
  );
}
