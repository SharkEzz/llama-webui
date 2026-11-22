// `pnpm profiling <scenario…>`: build, start what the scenarios need, run them in order, undo, write the report.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, release, totalmem } from 'node:os';
import type { Browser } from 'puppeteer-core';
import { startBrowser } from './browser.ts';
import { compare } from './compare.ts';
import { defaultProfileId, type Instance, portAnswers, prepareBuild, startInstance, undo } from './instance.ts';
import { arr, isRecord, str } from './json.ts';
import type { Context } from './measure.ts';
import { type Options, SCENARIOS, UsageError } from './options.ts';
import { renderReport } from './report/render.ts';
import {
  RESULTS_VERSION,
  type Results,
  type RunInfo,
  SCENARIO_NAMES,
  type ScenarioName,
  type ScenarioResults,
} from './results.ts';
import { PROFILING_ROOT, type RunDir, runDir } from './run-dir.ts';
import { SCENARIO_RUNNERS } from './scenarios/index.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);

/** Undoes every earlier run whose state.json still lists something (the tool was killed). */
async function cleanLeftovers(): Promise<void> {
  if (!existsSync(PROFILING_ROOT)) return;
  for (const entry of readdirSync(PROFILING_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(runDir(entry.name).file('state.json'))) continue;
    for (const line of await undo(runDir(entry.name))) say(`profiling: run ${entry.name} was left behind: ${line}`);
  }
}

function cpuModel(): string {
  try {
    return /^model name\s*:\s*(.+)$/m.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1]?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function runInfo(options: Options): RunInfo {
  return {
    name: options.name,
    startedAt: new Date().toISOString(),
    endedAt: null,
    scenarios: options.scenarios,
    options: {
      host: options.host,
      port: options.port,
      dataDir: options.dataDir,
      profileId: options.profile,
      chrome: options.chrome,
      build: options.build,
    },
    versions: { app: 'unknown', node: process.version, chromium: null, kernel: release() },
    machine: {
      cpu: cpuModel(),
      threads: availableParallelism(),
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      gpus: [],
    },
    profile: null,
    gpuCompositing: null,
    symbolicated: options.build,
  };
}

const writeRunInfo = (run: RunDir, info: RunInfo) => {
  mkdirSync(run.path, { recursive: true });
  writeFileSync(run.file('run.json'), `${JSON.stringify(info, null, 2)}\n`);
};

function setResult<K extends ScenarioName>(results: Results, name: K, value: ScenarioResults[K]): void {
  results.scenarios[name] = value;
}

/** The profile a model scenario will launch: --profile, else the instance's default, read from a short start. */
async function profileToLaunch(run: RunDir, options: Options): Promise<number> {
  if (options.profile !== null) return options.profile;
  const instance = await startInstance(run, options);
  try {
    const id = await defaultProfileId(instance.baseUrl);
    if (id === null)
      throw new UsageError('no profile to launch: pass --profile <id> or set a default profile in the app');
    return id;
  } finally {
    await instance.stop();
  }
}

export async function runCommand(options: Options): Promise<number> {
  // A closed stdout (piped to head) must not stop a run before its undo.
  process.stdout.on('error', () => undefined);
  const run = runDir(options.name);
  if (existsSync(run.path))
    throw new UsageError(`a run named ${options.name} exists (${run.path}): pick another --name`);
  if (options.compare !== null && !runDir(options.compare).exists())
    throw new UsageError(
      `no reference run ${options.compare}: ${runDir(options.compare).file('results.json')} does not exist`,
    );
  await cleanLeftovers();
  if (await portAnswers(options.host, options.port))
    throw new UsageError(`port ${String(options.port)} is in use: stop the instance that runs there first`);
  const needsModel = options.scenarios.some((s) => SCENARIOS[s].needsModel);
  // run.json first: an undo after a kill reads the address there.
  const info = runInfo(options);
  writeRunInfo(run, info);
  const profileId = needsModel ? await profileToLaunch(run, options) : null;
  info.options.profileId = profileId;
  writeRunInfo(run, info);
  const results: Results = { version: RESULTS_VERSION, run: info, scenarios: {}, failed: [] };
  let instance: Instance | null = null;
  let browser: Browser | null = null;

  const finish = async (): Promise<string> => {
    // The GPUs are listed once the monitor has sampled them, so at the end rather than at the start.
    if (instance !== null && info.machine.gpus.length === 0) {
      const system = await instance.api('/api/system/info').catch(() => null);
      if (isRecord(system))
        info.machine.gpus = arr(system.gpus).flatMap((g) => (isRecord(g) ? [str(g.name, 'GPU')] : []));
    }
    if (browser !== null) {
      await browser.close().catch(() => undefined);
      run.writeState({ ...run.readState(), chromePid: null });
    }
    for (const line of await undo(run)) say(`profiling: ${line}`);
    info.endedAt = new Date().toISOString();
    writeRunInfo(run, info);
    run.writeResults(results);
    const reference = options.compare === null ? null : runDir(options.compare).readResults();
    const out = run.file('report.html');
    writeFileSync(out, renderReport(results, reference === null ? null : compare(results, reference)));
    return out;
  };
  // Set by a signal handler: read through a function so the checks below are not narrowed away.
  const signalled = { stopping: false };
  const stopping = () => signalled.stopping;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping()) process.exit(130);
    signalled.stopping = true;
    say(`profiling: ${signal}: undoing, then writing what was measured (again to quit at once)`);
    finish().then(
      (out) => {
        say(out);
        process.exit(130);
      },
      (error: unknown) => {
        process.stderr.write(`profiling: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(130);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const context = (scenario: ScenarioName): Context => ({
    run,
    options: { ...options, profile: profileId },
    get instance(): Instance {
      if (instance === null) throw new Error('the server is not started');
      return instance;
    },
    browser,
    scenario,
    log: (line) => say(`[${scenario}] ${line}`),
  });
  const runScenario = async (name: ScenarioName) => {
    if (stopping()) return;
    say(`[${name}] ${SCENARIOS[name].summary}`);
    const t0 = Date.now();
    try {
      setResult(results, name, await SCENARIO_RUNNERS[name].run(context(name)));
      say(`[${name}] done in ${String(Math.round((Date.now() - t0) / 1000))} s`);
    } catch (error) {
      if (stopping()) return;
      const message = error instanceof Error ? error.message : String(error);
      results.failed.push({ scenario: name, error: message });
      say(`[${name}] failed: ${message}`);
    }
    run.writeResults(results);
  };

  try {
    say(options.build ? 'profiling: building with hidden source maps' : 'profiling: reusing the existing build');
    info.symbolicated = (await prepareBuild(run, options.build)).symbolicated;
    if (options.scenarios.includes('startup')) await runScenario('startup');
    const rest = options.scenarios.filter((s) => s !== 'startup');
    if (rest.length > 0 && !stopping()) {
      instance = await startInstance(run, options);
      const health = await instance.api('/api/health');
      info.versions.app = isRecord(health) ? str(health.version, 'unknown') : 'unknown';
      if (rest.some((s) => SCENARIOS[s].needsBrowser)) {
        const chromium = await startBrowser(run, options.chrome);
        browser = chromium.browser;
        info.versions.chromium = chromium.version;
        info.gpuCompositing = chromium.gpuCompositing;
      }
      writeRunInfo(run, info);
      for (const name of rest.filter((s) => !SCENARIOS[s].needsModel)) await runScenario(name);
      const withModel = rest.filter((s) => SCENARIOS[s].needsModel);
      if (withModel.length > 0 && profileId !== null && !stopping()) {
        if (!withModel.includes('launch')) {
          const { readyMs } = await instance.startProfile();
          say(`profiling: profile #${String(profileId)} ready in ${(readyMs / 1000).toFixed(1)} s`);
        }
        const profile = await instance.api(`/api/profiles/${String(profileId)}`);
        info.profile = { id: profileId, name: isRecord(profile) ? str(profile.name, `#${String(profileId)}`) : '' };
        for (const name of withModel) await runScenario(name);
      }
    }
  } catch (error) {
    if (stopping()) return new Promise<number>(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    say(`profiling: ${message}`);
    results.failed.push({
      scenario: SCENARIO_NAMES.find((s) => options.scenarios.includes(s)) ?? 'startup',
      error: message,
    });
  }
  if (stopping()) return new Promise<number>(() => undefined);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  say(await finish());
  return results.failed.length > 0 ? 1 : 0;
}
