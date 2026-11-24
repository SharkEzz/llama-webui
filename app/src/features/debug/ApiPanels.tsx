import { useState } from 'react';
import { type ApiCall, useDebugCapture } from '@/lib/debug/capture';
import { fmt, formatBytes, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Chip, Empty, JsonDetails, ms, Section, SHOWN } from './parts';

const STATE_TONE: Record<ApiCall['state'], string> = {
  pending: 'text-tone-amber',
  ok: 'text-muted-foreground',
  error: 'text-destructive',
  aborted: 'text-muted-foreground italic',
};

/** The calls of the API, those in flight first, then the newest. */
export function HttpPanel() {
  const calls = useDebugCapture((s) => s.view.calls);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const shown = calls.filter((c) => !errorsOnly || c.state === 'error').slice(-SHOWN);
  const ordered = [
    ...shown.filter((c) => c.state === 'pending'),
    ...shown.filter((c) => c.state !== 'pending').toReversed(),
  ];

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section
        title={`Calls (${calls.length})`}
        actions={
          <Chip pressed={errorsOnly} onClick={() => setErrorsOnly(!errorsOnly)}>
            errors only
          </Chip>
        }
      >
        {ordered.length === 0 ? (
          <Empty>No call since the capture started.</Empty>
        ) : (
          <ul className="flex flex-col font-mono text-[0.7rem]">
            {ordered.map((c) => (
              <li key={c.id}>
                <JsonDetails
                  value={() => ('reply' in c ? c.reply : c.state)}
                  summary={
                    <span className="flex items-center gap-2">
                      <span className="num text-muted-foreground">{formatTime(c.at)}</span>
                      <span className="w-12 shrink-0 font-semibold">{c.method}</span>
                      <span className="min-w-0 flex-1 truncate">{c.path}</span>
                      {c.stream && <span className="text-tone-blue">SSE</span>}
                      <span className={cn('shrink-0 num', STATE_TONE[c.state])}>
                        {c.status ?? c.state}
                        {c.tag !== undefined && ` ${c.tag}`}
                      </span>
                      <span className="w-16 shrink-0 text-right num text-muted-foreground">{ms(c.ms)}</span>
                      <span className="w-16 shrink-0 text-right num text-muted-foreground">
                        {c.bytes === undefined ? '—' : formatBytes(c.bytes)}
                      </span>
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

/** Characters per second of a stream, from its first event to its end (or now). */
function charRate(c: ApiCall, at: number): number | undefined {
  const s = c.stream;
  if (s?.firstEventMs === undefined || s.chars === 0) return undefined;
  const elapsed = (c.ms ?? at - c.at) - s.firstEventMs;
  return elapsed > 0 ? (s.chars * 1000) / elapsed : undefined;
}

/** The server-sent event streams (the chat's replies), newest first, each with its last events. */
export function SsePanel() {
  const streams = useDebugCapture((s) => s.view.streams);
  const now = useDebugCapture((s) => s.view.at);

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <Empty>No stream since the capture started (a chat reply opens one).</Empty>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-[0.7rem]">
            {streams.toReversed().map((c) => {
              const s = c.stream!;
              const rate = charRate(c, now);
              return (
                <li key={c.id} className="rounded border border-border/60">
                  <JsonDetails
                    value={() => s.last}
                    summary={
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="num text-muted-foreground">{formatTime(c.at)}</span>
                          <span className="font-semibold">{c.method}</span>
                          <span className="min-w-0 flex-1 truncate">{c.path}</span>
                          <span className={cn('shrink-0', STATE_TONE[c.state])}>
                            {c.state === 'pending' ? 'streaming' : c.state}
                            {c.tag !== undefined && ` ${c.tag}`}
                          </span>
                        </span>
                        <span className="flex flex-wrap gap-x-3 num text-muted-foreground">
                          <span>first event {ms(s.firstEventMs)}</span>
                          <span>
                            {s.events} events (
                            {Object.entries(s.byType)
                              .map(([t, n]) => `${t} ${n}`)
                              .join(', ') || 'none'}
                            )
                          </span>
                          <span>{s.chars} chars</span>
                          {rate !== undefined && <span>{fmt(rate, 0)} chars/s</span>}
                          <span>total {ms(c.ms)}</span>
                        </span>
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
