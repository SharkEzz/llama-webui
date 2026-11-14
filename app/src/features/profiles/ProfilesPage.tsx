import type { Settings } from '@llama-webui/shared';
import { Download, Plus, SlidersHorizontal, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { GlassCard } from '@/components/glass/GlassCard';
import { GLASS } from '@/components/glass/glass';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { call } from '@/lib/api';
import { importProfiles, importSummary, useProfiles } from '@/lib/profiles';
import { isRunning, useServer } from '@/lib/server';
import { cn } from '@/lib/utils';
import { ProfileForm } from './ProfileForm';

const basename = (p: string) => p.split('/').pop() ?? p;

export function ProfilesPage() {
  const { profiles, loaded, reload } = useProfiles();
  const [params, setParams] = useSearchParams();
  const [settings, setSettings] = useState<Settings | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const view = useServer((s) => s.view);

  useEffect(() => {
    void reload().catch((e: Error) => toast.error(e.message));
    call((api) => api.settings.get()).then(setSettings, () => {});
  }, [reload]);

  const creating = params.get('new') === '1';
  const requested = Number(params.get('id'));
  const selected = creating ? null : (profiles.find((p) => p.id === requested) ?? profiles[0] ?? null);
  const select = (id: number | 'new') => setParams(id === 'new' ? { new: '1' } : { id: String(id) }, { replace: true });

  // Opened without a selection: the running profile, written once into the URL (a later start or stop must not
  // change the selection, which would remount the form and lose its edits).
  const preselected = useRef(false);
  const runningId = isRunning(view) ? (view?.profileId ?? null) : null;
  useEffect(() => {
    if (preselected.current || !loaded || view === null) return;
    preselected.current = true;
    if (params.has('id') || params.has('new') || runningId === null) return;
    if (profiles.some((p) => p.id === runningId)) setParams({ id: String(runningId) }, { replace: true });
  }, [loaded, view, params, runningId, profiles, setParams]);

  const onFile = async (file: File) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toast.error(`${file.name} is not valid JSON`);
      return;
    }
    try {
      const r = await importProfiles(raw);
      await reload();
      const detail = r.skipped.map((s) => `${s.name}: ${s.reason}`).join('\n');
      const notify = r.imported.length > 0 ? toast.success : toast.warning;
      notify(importSummary(r), detail ? { description: detail } : undefined);
      if (r.imported[0]) select(r.imported[0].id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-3xl font-semibold tracking-tight">Profiles</h1>
        <Button onClick={() => select('new')}>
          <Plus /> New profile
        </Button>
        <Button variant="secondary" onClick={() => fileRef.current?.click()}>
          <Upload /> Import
        </Button>
        <Button
          variant="ghost"
          nativeButton={false}
          render={<a href="/api/profiles/export" download />}
          disabled={profiles.length === 0}
        >
          <Download /> Export all
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onFile(f);
          }}
        />
      </header>

      {loaded && profiles.length === 0 && !creating ? (
        <Alert className={GLASS}>
          <SlidersHorizontal />
          <AlertTitle>No profiles</AlertTitle>
          <AlertDescription>
            A profile combines the model to load and the llama-server arguments: create one, or import a JSON file
            exported from llama-webui.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Profiles" className={cn(GLASS, 'flex flex-col gap-0.5 p-2')}>
            {!loaded && [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            {creating && <div className="rounded-md bg-accent px-3 py-2 text-sm font-medium">New profile</div>}
            {profiles.map((p) => {
              const active = view?.profileId === p.id && isRunning(view);
              return (
                <Button
                  key={p.id}
                  variant="ghost"
                  onClick={() => select(p.id)}
                  aria-current={selected?.id === p.id ? 'true' : undefined}
                  className={cn(
                    'h-auto flex-col items-start gap-0.5 px-3 py-2 text-left',
                    selected?.id === p.id && 'bg-accent',
                  )}
                >
                  <span className="flex w-full items-center gap-2 text-sm font-medium">
                    <span className="truncate">{p.name}</span>
                    {active && (
                      <span className="ml-auto size-2 shrink-0 rounded-full bg-success" title="Server running" />
                    )}
                  </span>
                  <span className="w-full truncate font-mono text-[0.7rem] font-normal text-muted-foreground">
                    {basename(p.model)}
                  </span>
                </Button>
              );
            })}
          </nav>

          <GlassCard title={selected ? selected.name : 'New profile'}>
            <ProfileForm
              key={selected?.id ?? 'new'}
              profile={selected}
              settings={settings}
              onSaved={(p) => void reload().then(() => select(p.id))}
              onDeleted={() => void reload().then(() => setParams({}, { replace: true }))}
            />
          </GlassCard>
        </div>
      )}
    </div>
  );
}
