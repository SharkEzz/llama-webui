/**
 * Smoke test of the production build: `--help`, then a run on a free port with an empty data directory; the API
 * answers with the build's version, the UI and every file it references are served (from a deep URL), React is its
 * production build, and the WebSocket says hello. Exits 1 on the first failure, the server stopped.
 *
 *   node scripts/smoke.ts [app/.output/llama-webui.mjs]   the build's launcher, run by this Node
 *   node scripts/smoke.ts --tarball [file.tgz]    the package as a user installs it: `pnpm pack` (or the given
 *                                                 tarball), `npm install` into an empty prefix, then the same checks
 *                                                 through its `node_modules/.bin/llama-webui`
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { tarball: { type: 'boolean', default: false } },
});

function fail(message: string): never {
  throw new Error(message);
}

/** Temporary directories, removed however the run ends. */
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

process.on('uncaughtException', (err) => {
  console.error(`smoke: ${err.message}`);
  process.exit(1);
});

/** Runs `cmd`, fails with its output unless it succeeds. */
function run(cmd: string, args: string[], cwd = ROOT): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${r.status ?? r.signal}: ${r.stderr || r.error}`);
  return r.stdout;
}

/** The package installed from a tarball, the way a user does: its command, after checking what npm installed. */
function installTarball(given: string | undefined): string {
  const work = temp('lw-tarball-');
  let tgz = given ? resolve(given) : null;
  if (!tgz) {
    if (!existsSync(join(ROOT, 'app/.output/llama-webui.mjs'))) fail('no build to pack: run pnpm build first');
    run('pnpm', ['pack', '--pack-destination', work]);
    const packed = readdirSync(work).find((f) => f.endsWith('.tgz')) ?? fail('pnpm pack wrote no tarball');
    tgz = join(work, packed);
  }
  const prefix = join(work, 'prefix');
  run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', tgz], work);

  // Nothing but the package: the build bundles every dependency (scripts/package.test.ts).
  const modules = join(prefix, 'node_modules');
  const pkg = JSON.parse(readFileSync(join(modules, 'llama-webui/package.json'), 'utf8'));
  const wanted: Record<string, string> = { 'llama-webui': pkg.version, ...pkg.dependencies };
  const installed = readdirSync(modules)
    .filter((d) => !d.startsWith('.'))
    .flatMap((d) => (d.startsWith('@') ? readdirSync(join(modules, d)).map((s) => `${d}/${s}`) : [d]));
  for (const name of installed) {
    const { version } = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
    if (wanted[name] !== version)
      fail(`npm installed ${name}@${version}, the package names ${wanted[name] ?? 'nothing'}`);
  }
  if (installed.length !== Object.keys(wanted).length) fail(`npm installed ${installed.join(', ')}`);
  return join(modules, '.bin/llama-webui');
}

// The command that runs the app, and how it is named in the report.
const [cmd, ...cmdArgs] = values.tarball
  ? [installTarball(positionals[0])]
  : [process.execPath, resolve(positionals[0] ?? 'app/.output/llama-webui.mjs')];
const main = cmdArgs[0] ?? cmd;

const help = spawnSync(cmd, [...cmdArgs, '--help']);
if (help.status !== 0) fail(`--help exited with ${help.status ?? help.signal}: ${help.error ?? help.stderr}`);
if (!help.stdout.toString().includes('llama-webui [options]')) fail('--help does not show the usage');

/** A free port: the OS picks one, released right away. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}
const port = await freePort();
// A `PORT` in the environment (common on servers) must not win over `--port`.
const decoy = await freePort();

const dataDir = temp('lw-smoke-');
// As a user runs it: without `CI` or `TEST` (GitHub Actions sets `CI`), which a user never sets.
const env: Record<string, string | undefined> = { ...process.env, PORT: String(decoy) };
delete env.CI;
delete env.TEST;
// Run from the data directory: no .env or config of the repository around (the build carries its dependencies).
const proc = spawn(cmd, [...cmdArgs, '--data-dir', dataDir, '--port', String(port)], {
  cwd: dataDir,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise((done) => proc.once('exit', done));
const base = `http://127.0.0.1:${port}`;

/** The first message of a WebSocket on `/ws`. */
function firstMessage(): Promise<{ type?: string }> {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error('/ws: no message within 5 s')), 5000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      done(JSON.parse(String(e.data)) as { type?: string });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('/ws: connection failed'));
    };
  });
}

try {
  let health: Response | null = null;
  for (let i = 0; i < 100 && !health; i++) {
    health = await fetch(`${base}/api/health`).catch(() => null);
    if (!health) await sleep(100);
  }
  if (!health?.ok) fail('/api/health did not answer');
  const { version } = (await health.json()) as { version: string };
  if (!version || version === 'dev') fail(`no build version (${version})`);
  if (await fetch(`http://127.0.0.1:${decoy}/api/health`).catch(() => null)) fail(`listens on PORT=${decoy} too`);

  const page = await fetch(`${base}/chat/12`);
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) fail(`deep URL: ${page.status}`);
  const html = await page.text();
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg))"/g)].map((m) => m[1] as string);
  if (!refs.some((r) => r.endsWith('.js')) || !refs.some((r) => r.endsWith('.css'))) fail('no script or stylesheet');
  // React DOM registers with the devtools with its bundle type: 0 in production, 1 in development.
  const bundleTypes = new Set<string>();
  for (const r of refs) {
    const res = await fetch(`${base}${r}`);
    if (!res.ok) fail(`${r}: ${res.status}`);
    for (const m of (await res.text()).matchAll(/bundleType:(\d)/g)) bundleTypes.add(m[1] as string);
  }
  if (bundleTypes.size !== 1 || !bundleTypes.has('0')) fail(`React is not the production build (${[...bundleTypes]})`);

  const hello = await firstMessage();
  if (hello.type !== 'hello') fail(`/ws: first message is ${JSON.stringify(hello)}`);
  console.log(`smoke: ok (${main} ${version}, ${refs.length} files from ${base}/chat/12, /ws hello)`);
} finally {
  proc.kill();
  await exited;
}
