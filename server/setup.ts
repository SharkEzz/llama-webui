import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import {
  type BenchDevice,
  type BenchParams,
  type BenchRun,
  ctxFromArgs,
  type Estimate,
  isLoopback,
  type LaunchpadEntry,
  type ModelEntry,
  type Profile,
  paramsFromServerArgs,
  type SetupReport,
} from '@llama-webui/shared';
import type { ModelInfo } from './models/gguf';
import { expandHome } from './supervisor/args';

/** What the first-run report reads from the machine (injected: tested without the real binary, GPUs or perf). */
export interface SetupDeps {
  settings: { binary: string; modelsDir: string; host: string };
  /** `modelsDir` with `~` expanded. */
  modelsDir: string;
  resolveBinary(binary: string): Promise<string | null>;
  buildOf(binary: string): Promise<string | null>;
  benchBinary(serverBinary: string): string;
  listDevices(benchBinary: string): Promise<BenchDevice[]>;
  scanModels(dir: string): Promise<ModelEntry[]>;
  nvidiaSource: 'nvml' | 'nvidia-smi';
  readPerfParanoid(): Promise<number | null>;
  listen: { host: string; exposed: boolean };
}

/** An existing, executable regular file. */
async function executable(path: string): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return false;
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

const isDir = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

export async function buildSetupReport(d: SetupDeps): Promise<SetupReport> {
  const { binary, modelsDir: modelsSetting } = d.settings;
  const bench = d.benchBinary(expandHome(binary));
  const [resolved, exists, devices, perfParanoid] = await Promise.all([
    d.resolveBinary(expandHome(binary)),
    isDir(d.modelsDir),
    d.listDevices(bench),
    d.readPerfParanoid(),
  ]);
  const path = resolved && (await executable(resolved)) ? resolved : null;
  const version = path ? await d.buildOf(binary) : null;
  const models = exists ? (await d.scanModels(d.modelsDir)).filter((m) => m.ok && m.kind === 'model') : [];
  return {
    binary: { setting: binary, path, version },
    bench: { path: bench, devices },
    models: {
      setting: modelsSetting,
      dir: d.modelsDir,
      exists,
      count: models.length,
      bytes: models.reduce((a, m) => a + m.fileBytes, 0),
    },
    telemetry: { nvidiaSource: d.nvidiaSource, perfParanoid },
    listen: d.listen,
    llamaListen: { host: d.settings.host, exposed: !isLoopback(d.settings.host) },
    ready: path !== null && exists,
  };
}

/** `kernel.perf_event_paranoid`, null when unreadable. */
export async function readPerfParanoid(path = '/proc/sys/kernel/perf_event_paranoid'): Promise<number | null> {
  const text = await Bun.file(path)
    .text()
    .catch(() => null);
  const n = text === null ? Number.NaN : Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** The bench params a profile pins (estimate input). */
const pinnedOf = (args: string[]) => paramsFromServerArgs(args).params;

export interface LaunchpadDeps {
  /** Absolute model and projector paths of a profile. */
  paths(profile: Profile): { model: string; mmproj: string | null };
  loadModel(path: string): Promise<ModelInfo>;
  mmprojBytes(path: string | null): Promise<number>;
  /** Memory estimate with the profile's own args. */
  estimate(input: { model: ModelInfo; mmprojBytes: number; pinned: BenchParams; ctx?: number }): Promise<Estimate>;
  lastBench: Map<number, BenchRun>;
}

/** One card per profile; a profile whose model cannot be read still gets one (with `modelError`). */
export function buildLaunchpad(profiles: Profile[], d: LaunchpadDeps): Promise<LaunchpadEntry[]> {
  return Promise.all(
    profiles.map(async (p): Promise<LaunchpadEntry> => {
      const run = d.lastBench.get(p.id);
      const lastBench = run ? { ppTps: run.pp?.tps ?? null, tgTps: run.tg?.tps ?? null, at: run.createdAt } : null;
      const base = { profileId: p.id, name: p.name, lastBench, model: null, fit: null };
      let paths: { model: string; mmproj: string | null };
      try {
        paths = d.paths(p);
      } catch (e) {
        return { ...base, modelPath: null, modelError: (e as Error).message };
      }
      try {
        const [info, mmproj] = await Promise.all([d.loadModel(paths.model), d.mmprojBytes(paths.mmproj)]);
        // An estimate that fails (hardware unreadable) only drops the fit badge.
        const fit = await d
          .estimate({ model: info, mmprojBytes: mmproj, pinned: pinnedOf(p.args), ctx: ctxFromArgs(p.args) })
          .then(
            (e) => ({
              verdict: e.fit.verdict,
              reason: e.fit.reason,
              vramBytes: e.fit.vram.reduce((a, v) => a + v.bytes, 0),
              ramBytes: e.fit.ramBytes,
            }),
            () => null,
          );
        return {
          ...base,
          modelPath: paths.model,
          model: { name: info.name, quant: info.quant, fileBytes: info.fileBytes },
          modelError: null,
          fit,
        };
      } catch (e) {
        return { ...base, modelPath: paths.model, modelError: (e as Error).message };
      }
    }),
  );
}
