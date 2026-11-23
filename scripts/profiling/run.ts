// `pnpm profiling <scenario…>`: build, start what the scenarios need, run them in order, undo, write the report. With
// `--base <ref>`, two passes: the base ref, checked out and built in a worktree, then the working tree compared with it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, release, totalmem } from 'node:os';
import type { Browser } from 'puppeteer-core';
import { startBrowser } from './browser.ts';
import { compare } from './compare.ts';
import { copyDataDir, repoDataDir } from './datadir.ts';
import {
  checkoutBase,
  defaultProfileId,
  type Instance,
  ours,
  portAnswers,
  prepareBuild,
  startInstance,
  startTime,
  stopCommands,
  type Undone,
  undo,
} from './instance.ts';
import { arr, isRecord, str } from './json.ts';
import type { Context } from './measure.ts';
import { baseRunName, type Options, SCENARIOS, UsageError } from './options.ts';
import { llamaServers } from './procs.ts';
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
import { summary } from './summary.ts';
import { commitOf, HEAD, type Target, targetAt } from './target.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);

const report = (prefix: string, { done, failed }: Undone) => {
  for (const line of done) say(`${prefix}${line}`);
  for (const line of failed) say(`${prefix}${line}`);
};

/**
 * Undoes every earlier run whose state.json still lists something (the tool was killed). A run whose tool still runs
 * (another `pnpm profiling`) is not left behind: it is skipped, and its port is then refused below.
 */
async function cleanLeftovers(): Promise<void> {
  if (!existsSync(PROFILING_ROOT)) return;
  for (const entry of readdirSync(PROFILING_ROOT, { withFileTypes: true })) {
    const left = runDir(entry.name);
    if (!entry.isDirectory() || !existsSync(left.file('state.json'))) continue;
    const { toolPid, toolStart } = left.readState();
    if (ours(toolPid, toolStart)) {
      say(`profiling: run ${entry.name} is still running (pid ${String(toolPid)}): left as is`);
      continue;
    }
    report(`profiling: run ${entry.name} was left behind: `, await undo(left));
  }
}

function cpuModel(): string {
  try {
    return /^model name\s*:\s*(.+)$/m.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1]?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function runInfo(options: Options, name: string): RunInfo {
  return {
    name,
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
async function profileToLaunch(run: RunDir, options: Options, target: Target): Promise<number> {
  if (options.profile !== null) return options.profile;
  const instance = await startInstance(run, options, target);
  try {
    const id = await defaultProfileId(instance.baseUrl);
    if (id === null)
      throw new UsageError('no profile to launch: pass --profile <id> or set a default profile in the app');
    return id;
  } finally {
    await instance.stop();
  }
}

/** One side measured: its run on disk, the build it measures, and the run its report is compared with. */
interface Pass {
  run: RunDir;
  target: Target;
  compare: string | null;
  /** the data directory its server is given: `--data-dir`, or with `--base` this side's copy */
  dataDir: string | null;
  info: RunInfo;
  results: Results;
}

function newPass(options: Options, name: string, target: Target, reference: string | null): Pass {
  const info = runInfo(options, name);
  return {
    run: runDir(name),
    target,
    compare: reference,
    dataDir: options.dataDir,
    info,
    results: { version: RESULTS_VERSION, run: info, scenarios: {}, failed: [] },
  };
}

const never = (): Promise<number> => new Promise<number>(() => undefined);

export async function runCommand(options: Options): Promise<number> {
  // A closed stdout (piped to head) must not stop a run before its undo.
  process.stdout.on('error', () => undefined);
  const baseName = options.base === null ? null : baseRunName(options.name);
  for (const name of baseName === null ? [options.name] : [options.name, baseName]) {
    const dir = runDir(name);
    if (existsSync(dir.path)) throw new UsageError(`a run named ${name} exists (${dir.path}): pick another --name`);
  }
  if (options.compare !== null && !runDir(options.compare).exists())
    throw new UsageError(
      `no reference run ${options.compare}: ${runDir(options.compare).file('results.json')} does not exist`,
    );
  const baseCommit = options.base === null ? null : commitOf(options.base);
  if (options.base !== null && baseCommit === null)
    throw new UsageError(`--base: ${options.base} names no commit of this repository`);
  await cleanLeftovers();
  if (await portAnswers(options.host, options.port))
    throw new UsageError(`port ${String(options.port)} is in use: stop the instance that runs there first`);
  const needsModel = options.scenarios.some((s) => SCENARIOS[s].needsModel);
  if (needsModel) {
    const running = llamaServers();
    if (running.length > 0)
      throw new UsageError(
        `a llama-server is running (pid ${running.join(', ')}): stop it first, a scenario with a model needs the GPUs to itself`,
      );
  }
  const head = newPass(options, options.name, HEAD, baseName ?? options.compare);
  const base = baseName === null ? null : newPass(options, baseName, targetAt(runDir(baseName).file('src')), null);
  const passes = base === null ? [head] : [base, head];
  for (const pass of passes) {
    // run.json first: an undo after a kill reads the address there.
    writeRunInfo(pass.run, pass.info);
    // Who owns the run: another `pnpm profiling` does not undo it while this one runs.
    pass.run.writeState({ ...pass.run.readState(), toolPid: process.pid, toolStart: startTime(process.pid) });
  }
  let profileId: number | null = options.profile;
  // What the pass under measure has started: a signal undoes it from here.
  const live: { pass: Pass; instance: Instance | null; browser: Browser | null } = {
    pass: head,
    instance: null,
    browser: null,
  };

  const writeOut = async (pass: Pass): Promise<string> => {
    const { run, info, results } = pass;
    const mine = live.pass === pass;
    // The GPUs are listed once the monitor has sampled them, so at the end rather than at the start.
    if (mine && live.instance !== null && info.machine.gpus.length === 0) {
      const system = await live.instance.api('/api/system/info').catch(() => null);
      if (isRecord(system))
        info.machine.gpus = arr(system.gpus).flatMap((g) => (isRecord(g) ? [str(g.name, 'GPU')] : []));
    }
    if (mine && live.browser !== null) {
      await live.browser.close().catch(() => undefined);
      live.browser = null;
      run.writeState({ ...run.readState(), chromePid: null, chromeStart: null });
    }
    report('profiling: ', await undo(run));
    if (mine) live.instance = null;
    info.endedAt = new Date().toISOString();
    writeRunInfo(run, info);
    run.writeResults(results);
    // A base that was never measured has no results: the head's report is then written without comparison.
    const reference =
      pass.compare !== null && runDir(pass.compare).exists() ? runDir(pass.compare).readResults() : null;
    const comparison = reference === null ? null : compare(results, reference);
    const out = run.file('report.html');
    writeFileSync(out, renderReport(results, comparison));
    if (reference !== null && comparison !== null)
      writeFileSync(run.file('summary.md'), summary(results, reference, comparison));
    return out;
  };
  // Once per pass: a signal that arrives while a pass is being written out waits for it instead of undoing it twice.
  const written = new Map<Pass, Promise<string>>();
  const finish = (pass: Pass): Promise<string> => {
    let out = written.get(pass);
    if (out === undefined) {
      out = writeOut(pass);
      written.set(pass, out);
    }
    return out;
  };
  /** Undoes the passes that were not written out: the worktree of a base that was never measured. */
  const undoRest = async (): Promise<void> => {
    for (const pass of passes) if (!written.has(pass)) report('profiling: ', await undo(pass.run));
  };
  // Set by a signal handler: read through a function so the checks below are not narrowed away.
  const signalled = { stopping: false };
  const stopping = () => signalled.stopping;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping()) process.exit(130);
    signalled.stopping = true;
    say(`profiling: ${signal}: undoing, then writing what was measured (again to quit at once)`);
    stopCommands();
    finish(live.pass)
      .then(async (out) => {
        await undoRest();
        return out;
      })
      .then(
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

  const measurePass = async (pass: Pass): Promise<void> => {
    const { run, info, results, target } = pass;
    const passOptions: Options = { ...options, name: info.name, profile: profileId, dataDir: pass.dataDir };
    const context = (scenario: ScenarioName): Context => ({
      run,
      target,
      options: passOptions,
      get instance(): Instance {
        if (live.instance === null) throw new Error('the server is not started');
        return live.instance;
      },
      browser: live.browser,
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

    if (options.scenarios.includes('startup')) await runScenario('startup');
    const rest = options.scenarios.filter((s) => s !== 'startup');
    if (rest.length === 0 || stopping()) return;
    const instance = await startInstance(run, passOptions, target);
    live.instance = instance;
    const health = await instance.api('/api/health');
    info.versions.app = isRecord(health) ? str(health.version, 'unknown') : 'unknown';
    if (rest.some((s) => SCENARIOS[s].needsBrowser)) {
      const chromium = await startBrowser(run, options.chrome);
      live.browser = chromium.browser;
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
  };
  /** A failure outside a scenario, charged to the first one asked. */
  const fail = (pass: Pass, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    say(`profiling: ${message}`);
    pass.results.failed.push({
      scenario: SCENARIO_NAMES.find((s) => options.scenarios.includes(s)) ?? 'startup',
      error: message,
    });
  };

  // Everything is checked out and built before the first measure: a build that fails stops the command there, and
  // the two sides are measured one right after the other.
  let ready = true;
  try {
    if (base !== null && baseCommit !== null) {
      say(`profiling: checking out ${options.base ?? ''} (${baseCommit.slice(0, 9)}) in a worktree and installing it`);
      await checkoutBase(base.run, base.target, baseCommit);
      const source = repoDataDir(options.dataDir);
      say(`profiling: each side runs on its own copy of the data directory ${source}`);
      for (const pass of passes) pass.dataDir = copyDataDir(pass.run, source);
    }
    for (const pass of passes) {
      const side = base === null ? '' : pass === base ? ' the base' : ' the working tree';
      say(
        options.build ? `profiling: building${side} with hidden source maps` : 'profiling: reusing the existing build',
      );
      pass.info.symbolicated = (await prepareBuild(pass.run, options.build, pass.target)).symbolicated;
    }
    // Under the signal handlers: the short start that reads the default profile is undone too.
    if (needsModel) profileId = await profileToLaunch(head.run, { ...options, dataDir: head.dataDir }, head.target);
    for (const pass of passes) {
      pass.info.options.profileId = profileId;
      writeRunInfo(pass.run, pass.info);
    }
  } catch (error) {
    if (stopping()) return never();
    fail(head, error);
    ready = false;
  }
  if (ready)
    for (const pass of passes) {
      if (stopping()) return never();
      live.pass = pass;
      if (base !== null)
        say(`profiling: measuring ${pass === base ? `the base (${options.base ?? ''})` : 'the working tree'}`);
      try {
        await measurePass(pass);
      } catch (error) {
        if (stopping()) return never();
        fail(pass, error);
      }
      if (stopping()) return never();
      if (pass !== passes.at(-1)) say(await finish(pass));
    }
  if (stopping()) return never();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  // The head first, while its server still answers; then what a failed preparation left of the base.
  const out = await finish(head);
  await undoRest();
  say(out);
  return passes.some((pass) => pass.results.failed.length > 0) ? 1 : 0;
}
