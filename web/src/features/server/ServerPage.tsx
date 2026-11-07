import type { Settings } from '@llama-webui/shared';
import { CircleAlert, Copy, Info, Play, Repeat, RotateCw, ScrollText, Server, Square, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { LogRow } from '@/features/logs/LogRow';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { formatDuration } from '@/lib/format';
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

  // Profil proposé : celui du serveur, sinon le dernier utilisé, sinon le premier.
  const fallbackId = view?.profileId ?? defaultId ?? profiles[0]?.id ?? null;
  const selectedId = selected !== null ? Number(selected) : fallbackId;
  const selectedProfile = profiles.find((p) => p.id === selectedId);
  const currentProfile = profiles.find((p) => p.id === view?.profileId);
  const items = useMemo(() => profiles.map((p) => ({ value: String(p.id), label: p.name })), [profiles]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Serveur</h1>
        <ServerStateBadge state={state} className="text-base" />
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <GlassCard title="llama-server" icon={Server}>
          <StateDetails />
          <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5">
            {state.kind === 'external' ? (
              <p className="text-sm text-muted-foreground">
                Un llama-server lancé hors de llama-webui occupe le port {state.port}
                {state.pid !== null ? ` (PID ${state.pid})` : ''}. Arrêtez-le pour reprendre la main.
              </p>
            ) : loaded && profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun profil.{' '}
                <Link to="/profiles" className="text-primary underline-offset-4 hover:underline">
                  Créez ou importez un profil
                </Link>{' '}
                pour lancer llama-server.
              </p>
            ) : (
              <>
                <Select
                  items={items}
                  value={selectedId !== null ? String(selectedId) : null}
                  onValueChange={(v) => setSelected(v as string | null)}
                >
                  <SelectTrigger className="w-full" aria-label="Profil">
                    <SelectValue placeholder="Choisir un profil" />
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
                      <Play /> Démarrer
                    </Button>
                  )}
                  {running && selectedProfile && selectedId !== view?.profileId && (
                    <ConfirmDialog
                      title={`Basculer vers « ${selectedProfile.name} » ?`}
                      description={`llama-server sera arrêté${currentProfile ? ` (profil « ${currentProfile.name} »)` : ''} puis relancé avec ce profil. Les requêtes en cours seront interrompues.`}
                      confirmLabel="Basculer"
                      onConfirm={() => switchProfile(selectedProfile.id)}
                      trigger={
                        <Button disabled={busy}>
                          <Repeat /> Basculer
                        </Button>
                      }
                    />
                  )}
                  {running && (
                    <ConfirmDialog
                      title="Redémarrer llama-server ?"
                      description="Le profil courant est relu (modifications comprises) puis le serveur est relancé. Les requêtes en cours seront interrompues."
                      confirmLabel="Redémarrer"
                      onConfirm={restartServer}
                      trigger={
                        <Button variant="secondary" disabled={busy}>
                          <RotateCw /> Redémarrer
                        </Button>
                      }
                    />
                  )}
                  {running && (
                    <ConfirmDialog
                      title="Arrêter llama-server ?"
                      description="Le modèle sera déchargé de la mémoire. Les requêtes en cours seront interrompues."
                      confirmLabel="Arrêter"
                      destructive
                      onConfirm={stopServer}
                      trigger={
                        <Button variant="destructive" disabled={busy}>
                          <Square /> Arrêter
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

      <CommandCard command={view?.command ?? null} />
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
  if (!s || s.kind === 'idle') return <p className="text-sm text-muted-foreground">Aucun serveur en cours.</p>;
  return (
    <dl className="divide-y divide-border">
      {'profile' in s && <Row label="Profil">{s.profile}</Row>}
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
        <Row label={s.kind === 'ready' ? 'Prêt depuis' : 'Démarrage depuis'}>
          <span className="num">{formatDuration(now - s.since)}</span>
        </Row>
      )}
      {s.kind === 'crashed' && (
        <Row label="Arrêt">
          {[s.message, s.exitCode !== null ? `code ${s.exitCode}` : null, s.signal].filter(Boolean).join(', ') ||
            'inattendu'}
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
    .map(([m]) => ({ vision: 'image', video: 'vidéo', audio: 'audio' })[m] ?? m);

  return (
    <GlassCard title="Infos du serveur" icon={Info}>
      {!live ? (
        <p className="text-sm text-muted-foreground">Disponibles quand le serveur est prêt.</p>
      ) : error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Lecture de /props impossible</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !props ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Lecture de /props…">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <dl className="divide-y divide-border">
          <Row label="Modèle">
            <span className="font-mono text-xs" title={String(props.model_path ?? '')}>
              {String(props.model_alias ?? props.model_path ?? '—')}
            </span>
          </Row>
          {props.model_ftype !== undefined && <Row label="Quantification">{String(props.model_ftype)}</Row>}
          <Row label="Contexte">
            <span className="num">{typeof gen.n_ctx === 'number' ? gen.n_ctx.toLocaleString('fr-FR') : '—'}</span>{' '}
            tokens
          </Row>
          <Row label="Slots">
            <span className="num">{String(props.total_slots ?? '—')}</span>
          </Row>
          <Row label="Entrées en plus du texte">{modalities.length > 0 ? modalities.join(', ') : 'aucune'}</Row>
          <Row label="Build llama.cpp">
            <span className="num">{String(props.build_info ?? '—')}</span>
          </Row>
        </dl>
      )}
    </GlassCard>
  );
}

function CommandCard({ command }: { command: string | null }) {
  return (
    <GlassCard
      title="Commande effective"
      icon={Terminal}
      actions={
        command && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              copyText(command).then(
                () => toast.success('Commande copiée'),
                (e: Error) => toast.error(e.message),
              )
            }
          >
            <Copy /> Copier
          </Button>
        )
      }
    >
      {command ? (
        <pre className="overflow-x-auto rounded-md bg-well p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-foreground/90">
          {command}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">Aucun lancement depuis le démarrage de llama-webui.</p>
      )}
    </GlassCard>
  );
}

function RecentLogs() {
  const lines = useLogs((s) => s.lines);
  const last = lines.slice(-20);
  return (
    <GlassCard
      title="Derniers logs"
      icon={ScrollText}
      actions={
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/logs" />}>
          Tous les logs
        </Button>
      }
    >
      {last.length === 0 ? (
        <p className="text-sm text-muted-foreground">Rien pour l'instant.</p>
      ) : (
        <div className="flex flex-col rounded-md bg-well p-3">
          {last.map((l) => (
            <LogRow key={l.seq} line={l} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}
