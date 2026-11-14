import { isLoopback, type Settings, type ThemeMode } from '@llama-webui/shared';
import { ListChecks } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { GlassCard } from '@/components/glass/GlassCard';
import { GLASS } from '@/components/glass/glass';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDuration } from '@/lib/format';
import { type SettingsErrors, useSettingsEditor } from '@/lib/settings';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { EnvField, SwitchRow, TextField } from './fields';

const INTERVALS = [250, 500, 1000, 2000].map((ms) => ({ value: String(ms), label: `${ms} ms` }));
const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Settings saved field by field (PATCH /api/settings); validation error shown under the field. */
export function SettingsPage() {
  const { settings, errors, save } = useSettingsEditor();

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/setup" />}>
          <ListChecks /> Run setup again
        </Button>
      </header>
      {!settings ? (
        <Skeleton className="h-72" />
      ) : (
        <Tabs defaultValue="general">
          <TabsList className={cn(GLASS, 'h-9 p-1 *:px-3')}>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <General settings={settings} errors={errors} save={save} />
          </TabsContent>
          <TabsContent value="monitoring">
            <Monitoring settings={settings} save={save} />
          </TabsContent>
          <TabsContent value="appearance">
            <Appearance />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

interface SectionProps {
  settings: Settings;
  save(patch: Partial<Settings>): Promise<boolean>;
}

function General({ settings, errors, save }: SectionProps & { errors: SettingsErrors }) {
  return (
    <div className="flex flex-col gap-4">
      <Server settings={settings} errors={errors} save={save} />
      <GlassCard title="Environment variables">
        <EnvField
          id="env"
          hint="One variable per line, KEY=value. Applied to every profile started, and to benchmarks and Tuning sweeps; a profile variable with the same name wins. Takes effect at the next start."
          value={settings.env}
          error={errors.env}
          onCommit={(env) => save({ env })}
        />
      </GlassCard>
    </div>
  );
}

function Server({ settings, errors, save }: SectionProps & { errors: SettingsErrors }) {
  return (
    <GlassCard title="llama-server">
      <div className="grid gap-5 md:grid-cols-2">
        <TextField
          id="binary"
          label="Binary"
          hint="Path, or name in the PATH."
          value={settings.binary}
          error={errors.binary}
          onCommit={(v) => save({ binary: v })}
        />
        <TextField
          id="modelsDir"
          label="Models folder"
          hint="Default working directory of profiles."
          value={settings.modelsDir}
          error={errors.modelsDir}
          onCommit={(v) => save({ modelsDir: v })}
        />
        <TextField
          id="host"
          label="Default host"
          hint={
            isLoopback(settings.host) ? (
              'llama-server only accepts connections from this machine. 0.0.0.0 opens it to your network.'
            ) : (
              <span className="text-warning">
                llama-server is reachable from your network, with no authentication: anyone on it can send prompts to
                the loaded model.
              </span>
            )
          }
          value={settings.host}
          error={errors.host}
          onCommit={(v) => save({ host: v })}
        />
        <TextField
          id="port"
          label="Default port"
          value={String(settings.port)}
          error={errors.port}
          inputMode="numeric"
          onCommit={(v) => save({ port: Number(v) })}
        />
      </div>
    </GlassCard>
  );
}

function Monitoring({ settings, save }: SectionProps) {
  const [history, setHistory] = useState(settings.historySeconds);
  useEffect(() => setHistory(settings.historySeconds), [settings.historySeconds]);
  const c = settings.collectors;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <GlassCard title="Collection">
        <div className="flex flex-col gap-5">
          <SwitchRow
            id="nvml"
            label="NVML for NVIDIA GPUs"
            hint="Otherwise nvidia-smi (no PCIe bandwidth). Applied on the next llama-webui start."
            checked={c.nvml}
            onChange={(on) => save({ collectors: { ...c, nvml: on } })}
          />
          <SwitchRow
            id="sys"
            label="CPU and memory"
            checked={c.system}
            onChange={(on) => save({ collectors: { ...c, system: on } })}
          />
          <SwitchRow
            id="disk"
            label="Disks"
            checked={c.disk}
            onChange={(on) => save({ collectors: { ...c, disk: on } })}
          />
          <div className="flex flex-col gap-1.5">
            <Label>Polling interval</Label>
            <Select
              items={INTERVALS}
              value={String(settings.pollIntervalMs)}
              onValueChange={(v) => v && save({ pollIntervalMs: Number(v) })}
            >
              <SelectTrigger className="w-40" aria-label="Polling interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <Label>History kept</Label>
              <span className="num text-sm text-muted-foreground">{formatDuration(history * 1000)}</span>
            </div>
            <Slider
              min={30}
              max={1800}
              step={30}
              value={history}
              onValueChange={(v) => setHistory(Array.isArray(v) ? v[0]! : v)}
              onValueCommitted={(v) => save({ historySeconds: Array.isArray(v) ? v[0]! : v })}
              aria-label="History kept, in seconds"
            />
          </div>
        </div>
      </GlassCard>
      <GlassCard title="Displayed GPUs">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            A hidden GPU is no longer read (it is not woken up if asleep).
          </p>
          {/* The GPU list comes from the monitor (GET /api/system/info), which the Effect server does not serve yet. */}
          <p className="text-sm text-muted-foreground">
            Not ported yet: the GPU list is back with milestone E4 of the Effect server rewrite.
          </p>
        </div>
      </GlassCard>
    </div>
  );
}

function Appearance() {
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);
  return (
    <GlassCard title="Theme">
      <div className="flex flex-col gap-1.5">
        <Label>Interface theme</Label>
        <Select items={THEMES} value={mode} onValueChange={(v) => v && setMode(v as ThemeMode)}>
          <SelectTrigger className="w-40" aria-label="Theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">“System” follows the OS light or dark setting.</p>
      </div>
    </GlassCard>
  );
}
