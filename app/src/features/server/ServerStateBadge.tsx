import { loadProgressPct, type ServerState, stateLoadProgress } from '@llama-webui/shared';
import { formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';

const UI: Record<ServerState['kind'], { label: string; dot: string; text: string }> = {
  idle: { label: 'Stopped', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
  starting: { label: 'Starting…', dot: 'bg-tone-amber animate-pulse', text: 'text-tone-amber' },
  ready: { label: 'Ready', dot: 'bg-success shadow-[0_0_10px] shadow-success/60', text: 'text-success' },
  sleeping: { label: 'Sleeping', dot: 'bg-tone-blue/70', text: 'text-tone-blue' },
  stopping: { label: 'Stopping…', dot: 'bg-tone-amber animate-pulse', text: 'text-tone-amber' },
  crashed: { label: 'Crashed', dot: 'bg-destructive', text: 'text-destructive' },
  external: { label: 'External', dot: 'bg-tone-teal', text: 'text-tone-teal' },
};

/** Details of an abnormal exit, for the tooltip. */
export function crashDetail(s: ServerState): string | undefined {
  if (s.kind !== 'crashed') return undefined;
  const parts = [s.message, s.exitCode !== null ? `code ${s.exitCode}` : null, s.signal ? `signal ${s.signal}` : null];
  return parts.filter(Boolean).join(', ') || undefined;
}

export function ServerStateBadge({ state, className }: { state: ServerState; className?: string }) {
  const base = UI[state.kind];
  const extStatus = state.kind === 'external' ? state.status : undefined;
  const ui =
    extStatus === 'loading'
      ? { label: 'External · Loading', dot: 'bg-tone-amber animate-pulse', text: 'text-tone-amber' }
      : extStatus === 'sleeping'
        ? { label: 'External · Sleeping', dot: 'bg-tone-blue/70', text: 'text-tone-blue' }
        : base;
  const progress = stateLoadProgress(state);
  const pct = progress ? loadProgressPct(progress) : null;
  const extraParts: string[] = [];
  if (pct !== null) extraParts.push(formatPct(pct));
  if (state.kind === 'external' && state.pid !== null) extraParts.push(`(PID ${state.pid})`);
  const extra = extraParts.join(' ');
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-sm font-medium', ui.text, className)}
      title={crashDetail(state)}
    >
      <span className={cn('size-2 shrink-0 rounded-full', ui.dot)} aria-hidden="true" />
      {ui.label}
      {extra && <span className="num text-xs opacity-80">{extra}</span>}
    </span>
  );
}
