import { CACHE_TYPES, FLASH_ATTN, ignoredByBench, SPLIT_MODES } from '@llama-webui/shared';
import { Play, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ModelPicker } from '@/features/models/ModelPicker';
import { type BenchForm as Form, type FormField, splitArgs, useBench } from '@/lib/bench';
import { fmt } from '@/lib/format';
import { useProfiles } from '@/lib/profiles';
import { useServer } from '@/lib/server';

const DEFAULT = '__default';
const NO_PROFILE = '__none';

/** Run form: model, tool, one field per flag, other server flags; asks for confirmation if the server is running. */
export function BenchForm() {
  const form = useBench((s) => s.form);
  const errors = useBench((s) => s.errors);
  const devices = useBench((s) => s.devices);
  const live = useBench((s) => s.live);
  const launching = useBench((s) => s.launching);
  const setForm = useBench((s) => s.setForm);
  const profiles = useProfiles((s) => s.profiles);
  const reloadProfiles = useProfiles((s) => s.reload);
  const server = useServer((s) => s.view);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    void reloadProfiles();
    void useBench.getState().loadDevices();
  }, [reloadProfiles]);

  const external = server?.state.kind === 'external';
  const ignored = useMemo(() => {
    const split = splitArgs(form.serverArgs);
    return Array.isArray(split) ? ignoredByBench(split) : [];
  }, [form.serverArgs]);
  const gpuDevices = (devices ?? []).filter((d) => d.totalMib > 0);
  // A form -dev (from a profile or a rerun) missing from --list-devices stays listed, checked, so it can be removed.
  const missing = form.dev.filter((id) => !gpuDevices.some((d) => d.id === id));
  const shownDevices = [
    ...gpuDevices.map((d) => ({ id: d.id, label: `${d.name} · ${fmt(d.totalMib / 1024, 1)} GiB` })),
    ...missing.map((id) => ({ id, label: 'missing from --list-devices' })),
  ];

  const launch = async (stopServer = false) => {
    const r = await useBench.getState().launch(stopServer);
    if (r === 'confirm') {
      const s = server?.state;
      setConfirm(s && 'profile' in s ? s.profile : 'the active profile');
    }
  };

  const field = (k: FormField) => ({
    id: `bench-${k}`,
    value: form[k] as string,
    'aria-invalid': errors[k] ? true : undefined,
    onChange: (e: { target: { value: string } }) => setForm({ [k]: e.target.value } as Partial<Form>),
  });

  const profileItems = [
    { value: NO_PROFILE, label: 'None: model and flags' },
    ...profiles.map((p) => ({ value: String(p.id), label: p.name })),
  ];

  return (
    <GlassCard title="New benchmark" icon={Play}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Start from a profile</Label>
            <Select
              items={profileItems}
              value={form.profileId === null ? NO_PROFILE : String(form.profileId)}
              onValueChange={(v) => void useBench.getState().fromProfile(v && v !== NO_PROFILE ? Number(v) : null)}
            >
              <SelectTrigger className="w-full" aria-label="Starting profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profileItems.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Prefills the model and flags; the profile is not modified.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Tool</Label>
            <Tabs value={form.kind} onValueChange={(v) => setForm({ kind: v as Form['kind'] })}>
              <TabsList className="h-9 w-full p-1 *:px-3">
                <TabsTrigger value="bench">llama-bench</TabsTrigger>
                <TabsTrigger value="server">Server</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              {form.kind === 'bench'
                ? 'Raw llama.cpp measurement: no speculative decoding, no profile context.'
                : 'A real llama-server: a warm-up, then r chat requests (≈ p text tokens + instruction, n generated tokens).'}
            </p>
          </div>
        </div>

        <PathField
          label="Model"
          kind="model"
          error={errors.modelPath}
          {...field('modelPath')}
          onPick={(p) => setForm({ modelPath: p })}
        />
        <PathField
          label="Projector (optional)"
          kind="mmproj"
          error={errors.mmprojPath}
          hint={form.kind === 'bench' ? 'Ignored by llama-bench, kept for “Create profile” and “Rerun”.' : undefined}
          {...field('mmprojPath')}
          onPick={(p) => setForm({ mmprojPath: p })}
        />

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <TextField label="-ngl" hint="number, all or auto" error={errors.ngl} {...field('ngl')} />
          <TextField label="-ncmoe" error={errors.ncmoe} {...field('ncmoe')} />
          <TextField label="-t" hint="threads" error={errors.t} {...field('t')} />
          <TextField label="-b" error={errors.b} {...field('b')} />
          <TextField label="-ub" error={errors.ub} {...field('ub')} />
          <OptionField
            label="-sm"
            options={SPLIT_MODES}
            value={form.sm}
            error={errors.sm}
            onChange={(v) => setForm({ sm: v })}
          />
          <OptionField
            label="-fa"
            options={FLASH_ATTN}
            value={form.fa}
            error={errors.fa}
            onChange={(v) => setForm({ fa: v })}
          />
          <OptionField
            label="-ctk"
            options={CACHE_TYPES}
            value={form.ctk}
            error={errors.ctk}
            onChange={(v) => setForm({ ctk: v })}
          />
          <OptionField
            label="-ctv"
            options={CACHE_TYPES}
            value={form.ctv}
            error={errors.ctv}
            onChange={(v) => setForm({ ctv: v })}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">-dev and -ts</legend>
          {devices === null ? (
            <p className="text-xs text-muted-foreground">Reading devices…</p>
          ) : shownDevices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No devices read (llama-bench not found?): the choice stays automatic.
            </p>
          ) : (
            <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
              {shownDevices.map((d) => {
                const on = form.dev.includes(d.id);
                return (
                  <div key={d.id} className="flex items-center gap-3">
                    <Checkbox
                      id={`dev-${d.id}`}
                      checked={on}
                      onCheckedChange={(c) =>
                        setForm({ dev: c ? [...form.dev, d.id] : form.dev.filter((x) => x !== d.id) })
                      }
                    />
                    <Label htmlFor={`dev-${d.id}`} className="min-w-0 flex-1 font-normal">
                      <span className="font-mono text-xs">{d.id}</span>
                      <span className="truncate text-muted-foreground" title={d.label}>
                        {d.label}
                      </span>
                    </Label>
                    {on && (
                      <Input
                        className="h-7 w-16 font-mono text-xs"
                        aria-label={`-ts proportion for ${d.id}`}
                        placeholder="ts"
                        value={form.ts[d.id] ?? ''}
                        onChange={(e) => setForm({ ts: { ...form.ts, [d.id]: e.target.value } })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {form.dev.length === 0 && (
            <div className="flex items-center gap-3">
              <Label htmlFor="bench-tsAll" className="font-mono text-xs font-normal">
                -ts
              </Label>
              <Input
                id="bench-tsAll"
                className="h-7 w-40 font-mono text-xs"
                placeholder="e.g. 3,1"
                aria-invalid={errors.ts ? true : undefined}
                value={form.tsAll}
                onChange={(e) => setForm({ tsAll: e.target.value })}
              />
            </div>
          )}
          <FieldMessage
            error={errors.dev ?? errors.ts}
            hint="Nothing checked: the tool picks the devices, -ts in their order. Devices checked: -ts per device, in the order checked."
          />
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bench-ot">-ot</Label>
          <Textarea
            {...field('ot')}
            rows={2}
            className="font-mono text-xs"
            placeholder="one rule per line, e.g. exps=CPU"
          />
          <FieldMessage error={errors.ot} />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <TextField label="-p" hint="prompt tokens" error={errors.p} {...field('p')} />
          <TextField label="-n" hint="generated tokens" error={errors.n} {...field('n')} />
          <TextField label="-r" hint="repetitions" error={errors.r} {...field('r')} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bench-serverArgs">Other server flags</Label>
          <Textarea
            {...field('serverArgs')}
            rows={2}
            className="font-mono text-xs"
            placeholder="--jinja -c 40000 --spec-type draft-mtp"
          />
          <FieldMessage
            error={errors.serverArgs}
            hint={
              form.kind === 'bench'
                ? 'Ignored by llama-bench (kept for a server run or a profile).'
                : 'Passed as-is to llama-server.'
            }
          />
        </div>

        {form.kind === 'bench' && ignored.length > 0 && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>llama-bench will not reproduce the whole profile</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {ignored.map((i) => (
                  <li key={i.flag}>
                    <span className="font-mono">{i.flag}</span>: {i.why}
                  </li>
                ))}
              </ul>
              Its generation throughput is not directly comparable to a server run’s.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-end gap-3">
          {external && (
            <p className="text-xs text-muted-foreground">An external llama-server is running: stop it first.</p>
          )}
          <Button type="submit" disabled={live !== null || launching || external || form.modelPath.trim() === ''}>
            <Play /> Run
          </Button>
        </div>
      </form>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop llama-server?</AlertDialogTitle>
            <AlertDialogDescription>
              Profile “{confirm}” will be stopped during the benchmark, then restarted with the same command at the end,
              even if the run fails or is cancelled. Chat is unavailable in the meantime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(null);
                void launch(true);
              }}
            >
              Stop and run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </GlassCard>
  );
}

function FieldMessage({ error, hint }: { error?: string; hint?: string }) {
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  return hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null;
}

interface TextFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange(e: { target: { value: string } }): void;
}

function TextField({ id, label, hint, error, value, onChange }: TextFieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="font-mono">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        placeholder="default"
        className="font-mono"
      />
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

function PathField({
  id,
  label,
  kind,
  hint,
  error,
  value,
  onChange,
  onPick,
}: TextFieldProps & { kind: 'model' | 'mmproj'; onPick(p: string): void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={value}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          placeholder="/absolute/path/to/model.gguf"
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <ModelPicker kind={kind} onSelect={onPick} />
        </InputGroupAddon>
      </InputGroup>
      <FieldMessage error={error} hint={hint} />
    </div>
  );
}

function OptionField(props: {
  label: string;
  options: readonly string[];
  value: string;
  error?: string;
  onChange(v: string): void;
}) {
  const items = [{ value: DEFAULT, label: 'default' }, ...props.options.map((o) => ({ value: o, label: o }))];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="font-mono">{props.label}</Label>
      <Select
        items={items}
        value={props.value || DEFAULT}
        onValueChange={(v) => props.onChange(v && v !== DEFAULT ? v : '')}
      >
        <SelectTrigger
          className="w-full font-mono"
          aria-label={props.label}
          aria-invalid={props.error ? true : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} className="font-mono">
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldMessage error={props.error} />
    </div>
  );
}
