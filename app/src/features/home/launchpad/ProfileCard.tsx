import type { LaunchpadEntry, ServerView } from '@llama-webui/shared';
import { Activity, CircleStop, MessageSquare, Play, Repeat } from 'lucide-react';
import { Link } from 'react-router';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { crashDetail, ServerStateBadge } from '@/features/server/ServerStateBadge';
import { formatBytes, formatRate, formatShortDate } from '@/lib/format';
import { isRunning, startProfile, stopServer, switchProfile } from '@/lib/server';
import { cn } from '@/lib/utils';

function FitBadge({ fit }: { fit: NonNullable<LaunchpadEntry['fit']> }) {
  const label =
    fit.verdict === 'no'
      ? 'Does not fit'
      : fit.ramBytes > 0
        ? `${fit.verdict === 'tight' ? 'Tight' : 'Fits'} · ${formatBytes(fit.ramBytes, 0)} in RAM`
        : fit.verdict === 'tight'
          ? 'Tight in VRAM'
          : 'Fits in VRAM';
  const tone = { fits: 'text-success', tight: 'text-warning', no: 'text-destructive' }[fit.verdict];
  const title = [`${formatBytes(fit.vramBytes, 1)} on the GPUs`, fit.reason].filter(Boolean).join(' · ');
  return (
    <Badge variant="outline" className={tone} title={`Estimate with this profile's arguments: ${title}`}>
      {label}
    </Badge>
  );
}

/** One profile on the launch pad: what it runs, how fast it was, and a one-click start (or switch). */
export function ProfileCard({ entry, view, busy }: { entry: LaunchpadEntry; view: ServerView | null; busy: boolean }) {
  const state = view?.state;
  const mine = state && 'profileId' in state && state.profileId === entry.profileId ? state : null;
  const running = isRunning(view);
  const external = state?.kind === 'external';
  const ready = mine?.kind === 'ready';
  const pending = mine?.kind === 'starting' || mine?.kind === 'stopping';
  const m = entry.model;
  const b = entry.lastBench;

  return (
    <GlassCard
      title={entry.name}
      className={cn(ready && 'ring-1 ring-success/40')}
      actions={mine && <ServerStateBadge state={mine} />}
    >
      <div className="flex h-full flex-col gap-4 text-sm">
        <div className="flex flex-col gap-1">
          {m ? (
            <p className="truncate" title={entry.modelPath ?? undefined}>
              {m.name} <span className="text-muted-foreground">· {m.quant} · </span>
              <span className="num text-muted-foreground">{formatBytes(m.fileBytes)}</span>
            </p>
          ) : (
            <p className="text-destructive">{entry.modelError ?? 'Model unavailable'}</p>
          )}
          <p className="text-muted-foreground">
            {b ? (
              <>
                pp <span className="num text-foreground">{formatRate(b.ppTps)}</span> · tg{' '}
                <span className="num text-foreground">{formatRate(b.tgTps)}</span>{' '}
                <span className="text-xs">({formatShortDate(b.at)})</span>
              </>
            ) : (
              'No benchmark yet'
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">{entry.fit && <FitBadge fit={entry.fit} />}</div>
        {mine?.kind === 'crashed' && <p className="text-xs text-destructive">{crashDetail(mine)}</p>}

        <div className="mt-auto flex flex-wrap gap-2">
          {ready ? (
            <>
              <Button size="sm" nativeButton={false} render={<Link to="/chat" />}>
                <MessageSquare /> Chat
              </Button>
              <Button size="sm" variant="secondary" nativeButton={false} render={<Link to="/dashboard" />}>
                <Activity /> Dashboard
              </Button>
              <ConfirmDialog
                title="Stop llama-server?"
                description="The model will be unloaded from memory. Running requests will be interrupted."
                confirmLabel="Stop"
                destructive
                onConfirm={stopServer}
                trigger={
                  <Button size="sm" variant="ghost" disabled={busy}>
                    <CircleStop /> Stop
                  </Button>
                }
              />
            </>
          ) : pending ? (
            <Button size="sm" disabled>
              <Play /> {mine.kind === 'starting' ? 'Starting…' : 'Stopping…'}
            </Button>
          ) : running ? (
            <ConfirmDialog
              title={`Switch to “${entry.name}”?`}
              description="llama-server will be stopped and restarted with this profile. Running requests will be interrupted."
              confirmLabel="Switch"
              onConfirm={() => switchProfile(entry.profileId)}
              trigger={
                <Button size="sm" disabled={busy || !m}>
                  <Repeat /> Switch
                </Button>
              }
            />
          ) : (
            <Button
              size="sm"
              disabled={busy || !m || external || state?.kind === 'stopping'}
              title={external ? 'A llama-server started outside llama-webui is using the port' : undefined}
              onClick={() => void startProfile(entry.profileId)}
            >
              <Play /> Start
            </Button>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
