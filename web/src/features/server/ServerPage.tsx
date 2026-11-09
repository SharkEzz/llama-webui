import { isLoopback, type Settings, stateHost } from '@llama-webui/shared';
import {
  CircleAlert,
  Copy,
  Info,
  Play,
  Repeat,
  RotateCw,
  ScrollText,
  Server,
  ShieldAlert,
  Square,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LogRow } from '@/features/logs/LogRow';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { formatDuration, formatInt } from '@/lib/format';
import { useLogs } from '@/lib/logs';
import { useProfiles } from '@/lib/profiles';
import { isRunning, restartServer, startProfile, stopServer, switchProfile, useServer } from '@/lib/server';
import { useNow } from '@/lib/useNow';
import { ServerStateBadge } from './ServerStateBadge';

type Props = Record<string, unknown>;

export function ServerPage() {
  const { view, busy } = useServer();
  const { profiles, loaded, reload } = useProfiles();
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const state = view?.state ?? { kind: 'idle' as const };
  const running = isRunning(view);

  useEffect(() => {
    void reload().catch(() => {});
    void api<Settings>('/settings').then(
      (s) => setDefaultId(s.defaultProfileId),
      () => {},
    );
  }, [reload]);

  // Suggested profile: the server's, otherwise the last used, otherwise the first.
  const fallbackId = view?.profileId ?? defaultId ?? profiles[0]?.id ?? null;
  const selectedId = selected !== null ? Number(selected) : fallbackId;
  const selectedProfile = profiles.find((p) => p.id === selectedId);
  const currentProfile = profiles.find((p) => p.id === view?.profileId);
  const items = useMemo(() => profiles.map((p) => ({ value: String(p.id), label: p.name })), [profiles]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Server</h1>
        <ServerStateBadge state={state} className="text-base" />
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <GlassCard title="llama-server" icon={Server}>
          <StateDetails />
          <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5">
            {state.kind === 'external' ? (
              <p className="text-sm text-muted-foreground">
                A llama-server started outside llama-webui is using port {state.port}
                {state.pid !== null ? ` (PID ${state.pid})` : ''}. Stop it to take back control.
              </p>
            ) : loaded && profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No profiles.{' '}
                <Link to="/profiles" className="text-primary-ink underline-offset-4 hover:underline">
                  Create or import a profile
                </Link>{' '}
                to start llama-server.
              </p>
            ) : (
              <>
                <Select
                  items={items}
                  value={selectedId !== null ? String(selectedId) : null}
                  onValueChange={(v) => setSelected(v as string | null)}
                >
                  <SelectTrigger className="w-full" aria-label="Profile">
                    <SelectValue placeholder="Choose a profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap gap-2">
                  {!running && (
                    <Button
                      disabled={busy || !selectedProfile || state.kind === 'stopping'}
                      onClick={() => selectedId !== null && void startProfile(selectedId)}
                    >
                      <Play /> Start
                    </Button>
                  )}
                  {running && selectedProfile && selectedId !== view?.profileId && (
                    <ConfirmDialog
                      title={`Switch to “${selectedProfile.name}”?`}
                      description={`llama-server will be stopped${currentProfile ? ` (profile “${currentProfile.name}”)` : ''} and restarted with this profile. Running requests will be interrupted.`}
                      confirmLabel="Switch"
                      onConfirm={() => switchProfile(selectedProfile.id)}
                      trigger={
                        <Button disabled={busy}>
                          <Repeat /> Switch
                        </Button>
                      }
                    />
                  )}
                  {running && (
                    <ConfirmDialog
                      title="Restart llama-server?"
                      description="The current profile is reread (including changes), then the server is restarted. Running requests will be interrupted."
                      confirmLabel="Restart"
                      onConfirm={restartServer}
                      trigger={
                        <Button variant="secondary" disabled={busy}>
                          <RotateCw /> Restart
                        </Button>
                      }
                    />
                  )}
                  {running && (
                    <ConfirmDialog
                      title="Stop llama-server?"
                      description="The model will be unloaded from memory. Running requests will be interrupted."
                      confirmLabel="Stop"
                      destructive
                      onConfirm={stopServer}
                      trigger={
                        <Button variant="destructive" disabled={busy}>
                          <Square /> Stop
                        </Button>
                      }
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </GlassCard>

        <PropsCard />
      </div>

      <CommandCard command={view?.command ?? null} host={view ? stateHost(view.state) : null} />
      <RecentLogs />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function StateDetails() {
  const view = useServer((s) => s.view);
  const now = useNow(1000);
  const s = view?.state;
  if (!s || s.kind === 'idle') return <p className="text-sm text-muted-foreground">No server running.</p>;
  return (
    <dl className="divide-y divide-border">
      {'profile' in s && <Row label="Profile">{s.profile}</Row>}
      {'pid' in s && s.pid !== null && (
        <Row label="PID">
          <span className="num">{s.pid}</span>
        </Row>
      )}
      {'port' in s && (
        <Row label="Port">
          <span className="num">{s.port}</span>
        </Row>
      )}
      {(s.kind === 'starting' || s.kind === 'ready') && (
        <Row label={s.kind === 'ready' ? 'Ready for' : 'Starting for'}>
          <span className="num">{formatDuration(now - s.since)}</span>
        </Row>
      )}
      {s.kind === 'crashed' && (
        <Row label="Exit">
          {[s.message, s.exitCode !== null ? `code ${s.exitCode}` : null, s.signal].filter(Boolean).join(', ') ||
            'unexpected'}
        </Row>
      )}
    </dl>
  );
}

function PropsCard() {
  const state = useServer((s) => s.view?.state);
  const live = state?.kind === 'ready' || state?.kind === 'external';
  const key = live ? `${state.kind}-${state.pid}` : null;
  const [props, setProps] = useState<Props | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProps(null);
    setError(null);
    if (!key) return;
    api<Props>('/server/props').then(setProps, (e: Error) => setError(e.message));
  }, [key]);

  const gen = (props?.default_generation_settings ?? {}) as Props;
  const modalities = Object.entries((props?.modalities ?? {}) as Record<string, boolean>)
    .filter(([, on]) => on)
    .map(([m]) => ({ vision: 'image', video: 'video', audio: 'audio' })[m] ?? m);

  return (
    <GlassCard title="Server info" icon={Info}>
      {!live ? (
        <p className="text-sm text-muted-foreground">Available once the server is ready.</p>
      ) : error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Could not read /props</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !props ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Reading /props…">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <dl className="divide-y divide-border">
          <Row label="Model">
            <span className="font-mono text-xs" title={String(props.model_path ?? '')}>
              {String(props.model_alias ?? props.model_path ?? '—')}
            </span>
          </Row>
          {props.model_ftype !== undefined && <Row label="Quantization">{String(props.model_ftype)}</Row>}
          <Row label="Context">
            <span className="num">{typeof gen.n_ctx === 'number' ? formatInt(gen.n_ctx) : '—'}</span> tokens
          </Row>
          <Row label="Slots">
            <span className="num">{String(props.total_slots ?? '—')}</span>
          </Row>
          <Row label="Inputs besides text">{modalities.length > 0 ? modalities.join(', ') : 'none'}</Row>
          <Row label="Build llama.cpp">
            <span className="num">{String(props.build_info ?? '—')}</span>
          </Row>
        </dl>
      )}
    </GlassCard>
  );
}

function CommandCard({ command, host }: { command: string | null; host: string | null }) {
  return (
    <GlassCard
      title="Effective command"
      icon={Terminal}
      actions={
        command && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              copyText(command).then(
                () => toast.success('Command copied'),
                (e: Error) => toast.error(e.message),
              )
            }
          >
            <Copy /> Copy
          </Button>
        )
      }
    >
      {command ? (
        <div className="flex flex-col gap-2">
          <pre className="overflow-x-auto rounded-md bg-well inset-shadow-well p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-foreground/90">
            {command}
          </pre>
          {host !== null && !isLoopback(host) && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              llama-server is reachable from your network (--host {host}), with no authentication.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No launch since llama-webui started.</p>
      )}
    </GlassCard>
  );
}

function RecentLogs() {
  const lines = useLogs((s) => s.lines);
  const last = lines.slice(-20);
  return (
    <GlassCard
      title="Latest logs"
      icon={ScrollText}
      actions={
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/logs" />}>
          All logs
        </Button>
      }
    >
      {last.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <div className="flex flex-col rounded-md bg-well inset-shadow-well p-3">
          {last.map((l) => (
            <LogRow key={l.seq} line={l} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}
