/**
 * Smoke test of a compiled executable (`bun scripts/smoke-binary.ts [dist/llama-webui]`): `--help`, then a run on a
 * free port with an empty data directory; the API answers, the UI and every file it references are served (also
 * from a deep URL). Exits 1 on the first failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const binary = resolve(process.argv[2] ?? 'dist/llama-webui');

function fail(message: string): never {
  throw new Error(message);
}

process.on('uncaughtException', (err) => {
  console.error(`smoke: ${err.message}`);
  process.exit(1);
});

const help = spawnSync(binary, ['--help']);
if (help.status !== 0) fail(`--help exited with ${help.status}`);
if (!help.stdout.toString().includes('llama-webui [options]')) fail('--help does not show the binary usage');

// A free port: the OS picks one, released right away.
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const { port } = probe.address() as AddressInfo;
await new Promise((done) => probe.close(done));

const dataDir = mkdtempSync(join(tmpdir(), 'lw-smoke-'));
// Run from the data directory: no bunfig.toml or .env of the repository around.
const proc = spawn(binary, ['--data-dir', dataDir, '--port', String(port)], {
  cwd: dataDir,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise((done) => proc.once('exit', done));
const base = `http://127.0.0.1:${port}`;

try {
  let health: Response | null = null;
  for (let i = 0; i < 100 && !health; i++) {
    health = await fetch(`${base}/api/health`).catch(() => null);
    if (!health) await sleep(100);
  }
  if (!health?.ok) fail('/api/health did not answer');
  const { version } = (await health.json()) as { version: string };
  if (!version || version === 'dev') fail(`no compile-time version (${version})`);

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
  console.log(`smoke: ok (${binary} ${version}, ${refs.length} files from ${base}/chat/12)`);
} finally {
  proc.kill();
  await exited;
  rmSync(dataDir, { recursive: true, force: true });
}
