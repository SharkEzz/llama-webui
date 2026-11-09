import { isSetupCheck, type Settings, type SetupReport } from '@llama-webui/shared';
import {
  Boxes,
  Cpu,
  ExternalLink,
  Gauge,
  Import,
  ListChecks,
  Server,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { GpuSwitches, TextField } from '@/features/settings/fields';
import { CheckList } from '@/features/system/ChecksCard';
import { formatBytes, plural } from '@/lib/format';
import { useMonitor } from '@/lib/monitor';
import { importLlamaTui, importSummary, type LlamaTuiStatus, llamaTuiStatus, useProfiles } from '@/lib/profiles';
import type { SettingsErrors } from '@/lib/settings';
import { useTuning } from '@/lib/tuning';
import { Command, Step } from './Step';

export interface StepProps {
  report: SetupReport | null;
  settings: Settings;
  errors: SettingsErrors;
  /** Saves a setting, then re-reads the report. */
  save(patch: Partial<Settings>): Promise<unknown>;
}

const Path = ({ children }: { children: string }) => <span className="font-mono text-xs break-all">{children}</span>;

export function BinaryStep({ report, settings, errors, save }: StepProps) {
  const b = report?.binary;
  return (
    <Step title="llama-server" icon={Server} state={!b ? 'loading' : b.path ? 'done' : 'todo'}>
      {b &&
        (b.path ? (
          <p className="text-muted-foreground">
            Found at <Path>{b.path}</Path>
            {b.version && (
              <>
                {' '}
                · build <span className="num text-foreground">{b.version}</span>
              </>
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">
            <Path>{b.setting}</Path> cannot be found or is not executable. Build{' '}
            <a
              className="text-foreground underline underline-offset-2"
              href="https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md"
              target="_blank"
              rel="noreferrer"
            >
              llama.cpp
            </a>{' '}
            for your backend (CUDA, Vulkan, ROCm, CPU…), then give the path to its <Path>llama-server</Path>.
          </p>
        ))}
      <TextField
        id="setup-binary"
        label="Binary"
        hint="Absolute path, or a name found in the PATH."
        placeholder="/path/to/llama.cpp/build/bin/llama-server"
        value={settings.binary}
        error={errors.binary}
        onCommit={(v) => void save({ binary: v })}
      />
    </Step>
  );
}

export function BenchStep({ report }: Pick<StepProps, 'report'>) {
  const bench = report?.bench;
  return (
    <Step
      title="llama-bench"
      icon={Gauge}
      optional
      state={!bench ? 'loading' : bench.devices.length > 0 ? 'done' : 'warn'}
    >
      {bench &&
        (bench.devices.length > 0 ? (
          <>
            <p className="text-muted-foreground">
              <Path>{bench.path}</Path> sees {bench.devices.length} {plural(bench.devices.length, 'device')}:
            </p>
            <ul className="flex flex-col gap-1">
              {bench.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {d.id}
                  </Badge>
                  <span>{d.name}</span>
                  <span className="num text-muted-foreground">{formatBytes(d.totalMib * 2 ** 20, 0)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-muted-foreground">
            <Path>{bench.path}</Path> is missing or lists no device. It ships with llama.cpp builds: keep it next to{' '}
            <Path>llama-server</Path>. Without it, Benchmark and Tuning sweeps are unavailable and Tuning cannot see
            your GPUs.
          </p>
        ))}
    </Step>
  );
}

export function ModelsStep({ report, settings, errors, save }: StepProps) {
  const m = report?.models;
  return (
    <Step title="Models folder" icon={Boxes} state={!m ? 'loading' : m.exists ? 'done' : 'todo'}>
      {m &&
        (!m.exists ? (
          <p className="text-destructive">
            Folder not found: <Path>{m.dir}</Path>
          </p>
        ) : m.count === 0 ? (
          <p className="text-muted-foreground">
            No GGUF model in <Path>{m.dir}</Path> yet. Download some from{' '}
            <a
              className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
              href="https://huggingface.co/models?library=gguf"
              target="_blank"
              rel="noreferrer"
            >
              Hugging Face <ExternalLink className="size-3" />
            </a>{' '}
            into this folder (subfolders are scanned).
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="num text-foreground">{m.count}</span> {plural(m.count, 'model')},{' '}
            <span className="num text-foreground">{formatBytes(m.bytes)}</span> in <Path>{m.dir}</Path> ·{' '}
            <Link to="/models" className="text-foreground underline underline-offset-2">
              browse
            </Link>
          </p>
        ))}
      <TextField
        id="setup-models"
        label="Folder"
        hint="Scanned for .gguf files; also the default working directory of profiles."
        value={settings.modelsDir}
        error={errors.modelsDir}
        onCommit={(v) => void save({ modelsDir: v })}
      />
    </Step>
  );
}

const PERF_SESSION = 'sudo sysctl kernel.perf_event_paranoid=0';
const PERF_PERMANENT = "echo 'kernel.perf_event_paranoid = 0' | sudo tee /etc/sysctl.d/99-perf.conf";

export function GpuStep({ report, settings, save }: StepProps) {
  const gpus = useMonitor((s) => s.snapshot?.allGpus);
  const memBw = useMonitor((s) => (s.snapshot?.system ? s.snapshot.system.memBw != null : null));
  const t = report?.telemetry;
  const perfBlocked = memBw === false && t?.perfParanoid != null && t.perfParanoid > 0;
  const nvidia = gpus?.filter((g) => g.vendor === 'nvidia').length ?? 0;
  const amd = gpus?.filter((g) => g.vendor === 'amd').length ?? 0;

  return (
    <Step
      title="GPUs and telemetry"
      icon={Cpu}
      optional
      state={!gpus || !t ? 'loading' : perfBlocked ? 'warn' : 'done'}
    >
      {!gpus || !t ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          {gpus.length === 0 ? (
            <p className="text-muted-foreground">No GPU detected: llama-server will run on the CPU.</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {[
                  nvidia > 0 && `NVIDIA read through ${t.nvidiaSource === 'nvml' ? 'NVML' : 'nvidia-smi'}`,
                  amd > 0 && 'AMD read through the amdgpu driver',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                . Hide the cards llama-server should not watch (an integrated GPU, say): a hidden card is no longer read
                and stays asleep.
              </p>
              <div className="flex flex-col gap-4">
                <GpuSwitches
                  gpus={gpus}
                  hidden={settings.hiddenGpus}
                  onChange={(hiddenGpus) => void save({ hiddenGpus })}
                />
              </div>
            </>
          )}
          <div className="flex flex-col gap-2">
            <p className="font-medium">DRAM bandwidth</p>
            {memBw ? (
              <p className="text-muted-foreground">Measured with perf.</p>
            ) : perfBlocked ? (
              <>
                <p className="text-muted-foreground">
                  perf is not allowed to read the memory controller (<Path>kernel.perf_event_paranoid</Path> ={' '}
                  {String(t.perfParanoid)}): CPU activity is shown instead. Until reboot:
                </p>
                <Command>{PERF_SESSION}</Command>
                <p className="text-muted-foreground">Permanently:</p>
                <Command>{PERF_PERMANENT}</Command>
              </>
            ) : (
              <p className="text-muted-foreground">
                Not measured: it needs <Path>perf</Path> and an AMD Zen 4/5 CPU. CPU activity is shown instead.
              </p>
            )}
          </div>
        </>
      )}
    </Step>
  );
}

export function MachineStep() {
  const report = useTuning((s) => s.checks);
  useEffect(() => void useTuning.getState().loadChecks(null), []);
  const checks = useMemo(() => report?.checks.filter((c) => isSetupCheck(c.id)) ?? null, [report]);
  const warn = checks?.filter((c) => c.state === 'warn').length ?? 0;

  return (
    <Step
      title="Machine configuration"
      icon={ListChecks}
      optional
      state={!checks ? 'loading' : warn > 0 ? 'warn' : 'done'}
    >
      <p className="text-muted-foreground">
        System settings that affect llama.cpp speed. Nothing is changed for you: run the suggested commands yourself.
        Checks that depend on a model are on the{' '}
        <Link to="/system" className="text-foreground underline underline-offset-2">
          System
        </Link>{' '}
        page.
      </p>
      {!checks ? <Skeleton className="h-32" /> : <CheckList checks={checks} />}
    </Step>
  );
}

export function ProfileStep() {
  const profiles = useProfiles((s) => s.profiles);
  const loaded = useProfiles((s) => s.loaded);
  const [tui, setTui] = useState<LlamaTuiStatus | null>(null);

  useEffect(() => {
    void useProfiles.getState().reload();
    llamaTuiStatus().then(setTui, () => {});
  }, []);

  const offer = tui?.exists && tui.names.length > 0 && profiles.length === 0;
  const runImport = () =>
    importLlamaTui().then(
      (r) => {
        toast.success(importSummary(r));
        void useProfiles.getState().reload();
      },
      (e: Error) => toast.error(e.message),
    );

  return (
    <Step
      title="First profile"
      icon={SlidersHorizontal}
      optional
      state={!loaded ? 'loading' : profiles.length > 0 ? 'done' : 'info'}
    >
      <p className="text-muted-foreground">
        {profiles.length > 0
          ? `${profiles.length} ${plural(profiles.length, 'profile')}: ${profiles.map((p) => p.name).join(', ')}.`
          : 'A profile is a model plus its llama-server arguments, started in one click from Home.'}
      </p>
      {offer && tui && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {tui.names.length} llama-tui {plural(tui.names.length, 'profile')} found in <Path>{tui.path}</Path>:{' '}
            {tui.names.join(', ')}.
          </p>
          <Button size="sm" onClick={() => void runImport()}>
            <Import /> Import
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/profiles" />}>
          Create a profile
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/tuning" />}>
          Get a recommendation
        </Button>
      </div>
    </Step>
  );
}

export function NetworkStep({ report }: Pick<StepProps, 'report'>) {
  if (!report?.listen.exposed && !report?.llamaListen.exposed) return null;
  return (
    <Step title="Network access" icon={ShieldAlert} state="info">
      {report.listen.exposed && (
        <p className="text-muted-foreground">
          llama-webui listens on <Path>{report.listen.host}</Path> and has no authentication: anyone who can reach it
          can start processes on this machine. Only use it on a network you trust; start it without <Path>--host</Path>{' '}
          to keep it local.
        </p>
      )}
      {report.llamaListen.exposed && (
        <p className="text-muted-foreground">
          llama-server listens on <Path>{report.llamaListen.host}</Path> (Settings, <b>Default host</b>): any device on
          your network can send prompts to the loaded model. Set it to <Path>127.0.0.1</Path> to keep it local.
        </p>
      )}
    </Step>
  );
}
