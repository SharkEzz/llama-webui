import type { RequestRecord } from '@llama-webui/shared';
import { ListOrdered } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatInt, formatPct, formatTime, num } from '@/lib/format';

const MAX_ROWS = 20;
const dec = (v: number | null, digits = 1) => (v === null || !Number.isFinite(v) ? '—' : num(digits).format(v));

/** Latest requests, rebuilt tick by tick from the /metrics counters (approximate with several slots). */
export function RequestsTable({ requests }: { requests: RequestRecord[] }) {
  const rows = requests.slice(0, MAX_ROWS);
  return (
    <GlassCard title="Recent requests" icon={ListOrdered}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requests since this server started.</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="text-right">Cache</TableHead>
              <TableHead className="text-right">Generated</TableHead>
              <TableHead className="text-right">Duration (s)</TableHead>
              <TableHead className="text-right">Prompt tok/s</TableHead>
              <TableHead className="text-right">Generation tok/s</TableHead>
              <TableHead className="text-right">Acceptance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="num">
            {rows.map((r) => (
              <TableRow key={r.at}>
                <TableCell>{formatTime(r.at)}</TableCell>
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
