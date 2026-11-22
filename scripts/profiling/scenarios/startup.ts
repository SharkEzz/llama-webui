// startup: five launches of the production build, spawn to /api/health and SIGTERM to exit; one launch under
// --cpu-prof left up 20 s (the monitor at rest and the NVML sampler with it); bare Node for scale.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCpuProfile, summarizeProfile } from '../analyze/cpuprofile.ts';
import { serverOrigins } from '../analyze/origins.ts';
import { alive, baseUrlOf, LAUNCHER, now, REPO, SERVER_BUNDLE, sleep, terminate, waitHealth } from '../instance.ts';
import { parseJson } from '../json.ts';
import { type Context, dataDir, type Scenario } from '../measure.ts';

const LAUNCHES = 5;

async function launch(
  ctx: Context,
  env: NodeJS.ProcessEnv,
  upMs: number,
): Promise<{ pid: number; startMs: number; stopMs: number }> {
  const { options, run } = ctx;
  const args = [LAUNCHER, '--host', options.host, '--port', String(options.port)];
  if (options.dataDir !== null) args.push('--data-dir', options.dataDir);
  const t0 = now();
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: 'ignore', env });
  const pid = child.pid;
  if (pid === undefined) throw new Error('the server did not spawn');
  run.writeState({ ...run.readState(), serverPid: pid });
  if (!(await waitHealth(baseUrlOf(options.host, options.port), 20_000))) {
    await terminate(pid);
    throw new Error('the server did not answer /api/health within 20 s');
  }
  const startMs = now() - t0;
  await sleep(upMs);
  const t1 = now();
  child.kill('SIGTERM');
  while (alive(pid) && now() - t1 < 10_000) await sleep(5);
  const stopMs = now() - t1;
  if (alive(pid)) await terminate(pid, 0, 'SIGKILL');
  run.writeState({ ...run.readState(), serverPid: null });
  return { pid, startMs, stopMs };
}

export const startup: Scenario<'startup'> = {
  name: 'startup',
  run: async (ctx) => {
    const startMs: number[] = [];
    const stopMs: number[] = [];
    for (let i = 0; i < LAUNCHES; i++) {
      const r = await launch(ctx, process.env, 1500);
      startMs.push(r.startMs);
      stopMs.push(r.stopMs);
      ctx.log(`launch ${String(i + 1)}: start ${r.startMs.toFixed(0)} ms, stop ${r.stopMs.toFixed(0)} ms`);
      await sleep(500);
    }
    const dir = dataDir(ctx);
    const profiled = await launch(
      ctx,
      { ...process.env, NODE_OPTIONS: `--cpu-prof --cpu-prof-interval=200 --cpu-prof-dir=${dir}` },
      20_000,
    );
    // Node names the file CPU.<date>.<time>.<pid>.<thread>.<seq>.cpuprofile; the NVML sampler writes its own.
    const file = readdirSync(dir).find((f) => f.endsWith('.cpuprofile') && f.split('.').includes(String(profiled.pid)));
    if (file === undefined) throw new Error(`the profiled launch wrote no CPU profile in ${dir}`);
    const launchProfile = summarizeProfile(
      parseCpuProfile(parseJson(readFileSync(join(dir, file), 'utf8'))),
      serverOrigins(SERVER_BUNDLE),
    );
    const bareNodeMs: number[] = [];
    for (let i = 0; i < LAUNCHES; i++) {
      const t0 = now();
      await new Promise((done) => spawn(process.execPath, ['-e', '']).once('exit', done));
      bareNodeMs.push(now() - t0);
    }
    return { startMs, stopMs, bareNodeMs, launchProfile };
  },
};
