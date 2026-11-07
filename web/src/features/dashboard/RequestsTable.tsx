import type { RequestRecord } from '@llama-webui/shared';
import { ListOrdered } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatInt, formatPct } from '@/lib/format';

const MAX_ROWS = 20;
const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dec = (v: number | null, digits = 1) =>
  v === null || !Number.isFinite(v)
    ? '—'
    : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);

/** Dernières requêtes, reconstituées tick par tick à partir des compteurs /metrics (approximation si plusieurs slots). */
export function RequestsTable({ requests }: { requests: RequestRecord[] }) {
  const rows = requests.slice(0, MAX_ROWS);
  return (
    <GlassCard title="Requêtes récentes" icon={ListOrdered}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune requête depuis le démarrage de ce serveur.</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Heure</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="text-right">Cache</TableHead>
              <TableHead className="text-right">Générés</TableHead>
              <TableHead className="text-right">Durée (s)</TableHead>
              <TableHead className="text-right">Prompt tok/s</TableHead>
              <TableHead className="text-right">Génération tok/s</TableHead>
              <TableHead className="text-right">Acceptation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="num">
            {rows.map((r) => (
              <TableRow key={r.at}>
                <TableCell>{time.format(r.at)}</TableCell>
                <TableCell className="text-right">{formatInt(r.promptTokens)}</TableCell>
                <TableCell className="text-right">{formatInt(r.cachedTokens)}</TableCell>
                <TableCell className="text-right">{formatInt(r.genTokens)}</TableCell>
                <TableCell className="text-right">{dec((r.promptSec ?? 0) + (r.genSec ?? 0), 2)}</TableCell>
                <TableCell className="text-right">{dec(r.ppTps)}</TableCell>
                <TableCell className="text-right">{dec(r.genTps)}</TableCell>
                <TableCell className="text-right">
                  {r.specAccept === null ? '—' : formatPct(100 * r.specAccept)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GlassCard>
  );
}
