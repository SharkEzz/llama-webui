import { DEFAULT_SETTINGS, defer, type Profile, reservedFlag, type Settings } from '@llama-webui/shared';
import { Copy, Download, Play, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CodeTextarea } from '@/components/CodeTextarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProfile, deleteProfile, duplicateProfile, type NewProfile, updateProfile } from '@/lib/profiles';
import { isRunning, restartServer, startProfile, useServer } from '@/lib/server';
import { ArgsEditor } from './ArgsEditor';
import { parseArgs, parseEnv } from './argsText';
import { commandChanged, type Draft, draftOf } from './draft';
import { type FieldErrors, fieldErrors } from './errors';
import { highlightEnv } from './highlight';

interface ProfileFormProps {
  profile: Profile | null;
  settings: Settings | null;
  onSaved(p: Profile): void;
  onDeleted(): void;
  /** Initial values of a new profile (“Create profile” from the Models page). */
  initial?: Partial<Draft>;
}

export function ProfileForm({ profile, settings, onSaved, onDeleted, initial }: ProfileFormProps) {
  const [draft, setDraft] = useState(() => draftOf(profile, initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [restartAsk, setRestartAsk] = useState(false);
  const view = useServer((s) => s.view);
  const isActive = profile !== null && view?.profileId === profile.id && isRunning(view);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(profile)), [draft, profile]);

  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const args = parseArgs(draft.args);
  const env = parseEnv(draft.env);
  // Reserved flags: the editor already flags them, the API would reject them.
  const blocked = !Array.isArray(args) || args.some((a) => reservedFlag(a)) || 'error' in env;

  const save = async () => {
    if (blocked || !Array.isArray(args) || 'error' in env) return;
    const port = draft.port.trim();
    // An empty optional field is left out: the profile then takes the value of the settings.
    const optional = (key: 'mmproj' | 'cwd' | 'host') => {
      const value = draft[key].trim();
      return value ? { [key]: value } : {};
    };
    const input: NewProfile = {
      name: draft.name.trim(),
      model: draft.model.trim(),
      ...optional('mmproj'),
      ...optional('cwd'),
      ...optional('host'),
      ...(port ? { port: Number(port) } : {}),
      args,
      env,
    };
    setSaving(true);
    using _saving = defer(() => setSaving(false));
    try {
      const saved = profile ? await updateProfile(profile.id, input) : await createProfile(input);
      setErrors({});
      toast.success(profile ? 'Profile saved' : 'Profile created');
      // The running server still uses the previous version: offer to restart it.
      if (profile && isActive && commandChanged(profile, saved)) setRestartAsk(true);
      onSaved(saved);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const field = (k: keyof Draft, label: string, opts: { placeholder?: string; hint?: string; mono?: boolean } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pf-${k}`}>{label}</Label>
      <Input
        id={`pf-${k}`}
        value={draft[k]}
        onChange={set(k)}
        placeholder={opts.placeholder}
        aria-invalid={!!errors[k]}
        className={opts.mono ? 'font-mono text-xs' : undefined}
        spellCheck={false}
      />
      {errors[k] ? (
        <p className="text-sm text-destructive">{errors[k]}</p>
      ) : (
        opts.hint && <p className="text-xs text-muted-foreground">{opts.hint}</p>
      )}
    </div>
  );

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field('name', 'Name')}
        {field('cwd', 'Working directory', {
          placeholder: '~/models',
          hint: 'Relative model paths start from here.',
          mono: true,
        })}
        {field('model', 'Model (GGUF)', { placeholder: 'Qwen3.8-27B-IQ3_S.gguf', mono: true })}
        {field('mmproj', 'Multimodal projector', { placeholder: 'optional', mono: true })}
        {field('host', 'Host', {
          placeholder: settings?.host ?? DEFAULT_SETTINGS.host,
          hint: 'Empty: value from settings.',
          mono: true,
        })}
        {field('port', 'Port', {
          placeholder: String(settings?.port ?? 8080),
          hint: 'Empty: value from settings.',
          mono: true,
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pf-args">llama-server arguments</Label>
        <ArgsEditor id="pf-args" value={draft.args} onChange={(args) => setDraft((d) => ({ ...d, args }))} />
        {errors.args && <p className="text-sm text-destructive">{errors.args}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pf-env">Environment variables</Label>
        <CodeTextarea
          id="pf-env"
          value={draft.env}
          onChange={(env) => setDraft((d) => ({ ...d, env }))}
          highlight={highlightEnv}
          placeholder="CUDA_VISIBLE_DEVICES=0,1"
          aria-invalid={'error' in env}
        />
        {'error' in env ? (
          <p className="text-sm text-destructive">{String(env.error)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            One variable per line, KEY=value. Added to the variables of Settings, which they override.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={restartAsk}
        onOpenChange={setRestartAsk}
        title="Restart llama-server?"
        description={`“${draft.name.trim()}” is running with its previous settings. Restart it to apply the changes? Running requests will be interrupted.`}
        cancelLabel="Later"
        confirmLabel="Restart"
        onConfirm={restartServer}
      />

      {errors.form && <p className="text-sm text-destructive">{errors.form}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <Button type="submit" disabled={saving || !dirty || blocked}>
          <Save /> {profile ? 'Save' : 'Create profile'}
        </Button>
        {profile && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={dirty || isRunning(view) || view?.state.kind === 'external'}
              title={
                dirty
                  ? 'Save first'
                  : isRunning(view)
                    ? 'A server is already running: use Switch on the Server page'
                    : undefined
              }
              onClick={() => void startProfile(profile.id)}
            >
              <Play /> Start this profile
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                duplicateProfile(profile.id).then(
                  (p) => {
                    toast.success(`Copy created: ${p.name}`);
                    onSaved(p);
                  },
                  (e: Error) => toast.error(e.message),
                )
              }
            >
              <Copy /> Duplicate
            </Button>
            <Button
              type="button"
              variant="ghost"
              nativeButton={false}
              render={<a href={`/api/profiles/${profile.id}/export`} download />}
            >
              <Download /> Export
            </Button>
            <div className="ml-auto">
              <ConfirmDialog
                title={`Delete “${profile.name}”?`}
                description="The profile will be permanently deleted. Export it first if you want to keep it."
                confirmLabel="Delete"
                destructive
                onConfirm={() =>
                  deleteProfile(profile.id).then(
                    () => {
                      toast.success('Profile deleted');
                      onDeleted();
                    },
                    (e: Error) => toast.error(e.message),
                  )
                }
                trigger={
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={isActive}
                    title={isActive ? 'Stop the server first' : undefined}
                  >
                    <Trash2 /> Delete
                  </Button>
                }
              />
            </div>
          </>
        )}
      </div>
    </form>
  );
}
