import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { useDebugCapture } from '@/lib/debug/capture';
import { fmt, formatBytes, formatDuration, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { wsListenerCounts } from '@/lib/ws';
import { Chip, Empty, Facts, JsonDetails, ms, Section, SHOWN, Table } from './parts';

/** The socket: its connection, the rate of each message type, and the frames, newest first. */
export function WsPanel() {
  const view = useDebugCapture((s) => s.view);
  const [type, setType] = useState<string | null>(null);
  const { ws } = view;
  const subscribers = wsListenerCounts();
  const now = view.at;

  const frames = view.frames
    .filter((f) => type === null || f.type === type)
    .slice(-SHOWN)
    .toReversed();

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title="Connection">
        <Facts
          items={[
            [
              'Status',
              <span key="status" className={cn(ws.status === 'closed' && 'text-destructive')}>
                {ws.status}
              </span>,
            ],
            ['URL', ws.url || '—'],
            ['Open since', ws.openedAt ? `${formatTime(ws.openedAt)} (${formatDuration(now - ws.openedAt)})` : '—'],
            ['Reconnects', String(ws.reconnects)],
            ['Next attempt in', ws.status === 'closed' ? ms(ws.retryMs) : '—'],
            [
              'Last close',
              ws.lastClose
                ? `${formatTime(ws.lastClose.at)}, code ${ws.lastClose.code}${ws.lastClose.reason ? ` (${ws.lastClose.reason})` : ''}${ws.lastClose.clean ? '' : ', not clean'}`
                : '—',
            ],
            ['Clock offset', ws.clockOffsetMs === undefined ? '—' : `${fmt(ws.clockOffsetMs, 0)} ms (server − page)`],
            [
              'Boot ids',
              ws.bootIds.length === 0
                ? '—'
                : ws.bootIds.map((b) => `${b.bootId.slice(0, 8)} at ${formatTime(b.at)}`).join(', '),
            ],
          ]}
        />
      </Section>

      <Section title="Message types">
        {view.wsTypes.length === 0 ? (
          <Empty>No message received since the capture started.</Empty>
        ) : (
          <Table head={['Type', 'Count', 'Msg/s', 'Rate', 'Total', 'Subscribers']}>
            {view.wsTypes
              .toSorted((a, b) => b.bytes - a.bytes)
              .map((t) => (
                <tr key={t.type} className={cn(t.type === '?' && 'text-destructive')}>
                  <td className="px-1.5 py-0.5 font-mono">{t.type === '?' ? 'rejected' : t.type}</td>
                  <td className="px-1.5 py-0.5">{t.count}</td>
                  <td className="px-1.5 py-0.5">{fmt(t.perSecond, 1)}</td>
                  <td className="px-1.5 py-0.5">{formatBytes(t.bytesPerSecond)}/s</td>
                  <td className="px-1.5 py-0.5">{formatBytes(t.bytes)}</td>
                  <td className="px-1.5 py-0.5">{subscribers.get(t.type) ?? 0}</td>
                </tr>
              ))}
          </Table>
        )}
      </Section>

      <Section
        title={`Frames (last ${Math.min(view.frames.length, SHOWN)} of ${view.frames.length})`}
        actions={
          <div className="flex flex-wrap justify-end gap-1">
            <Chip pressed={type === null} onClick={() => setType(null)}>
              all
            </Chip>
            {view.wsTypes.map((t) => (
              <Chip key={t.type} pressed={type === t.type} onClick={() => setType(t.type)}>
                {t.type === '?' ? 'rejected' : t.type}
              </Chip>
            ))}
          </div>
        }
      >
        {frames.length === 0 ? (
          <Empty>No frame.</Empty>
        ) : (
          <ul className="flex flex-col font-mono text-[0.7rem]">
            {frames.map((f) => (
              <li key={f.id}>
                <JsonDetails
                  value={() => f.data}
                  summary={
                    <span className={cn('flex items-center gap-2', f.error !== undefined && 'text-destructive')}>
                      <span className="num text-muted-foreground">{formatTime(f.at)}</span>
                      {f.dir === 'in' ? (
                        <ArrowDownLeft className="size-3 shrink-0 text-tone-teal" aria-label="received" />
                      ) : (
                        <ArrowUpRight className="size-3 shrink-0 text-tone-amber" aria-label="sent" />
                      )}
                      <span className="shrink-0">{f.type === '?' ? 'rejected' : f.type}</span>
                      <span className="num text-muted-foreground">{formatBytes(f.size)}</span>
                      {f.error !== undefined && <span className="truncate">{f.error}</span>}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
