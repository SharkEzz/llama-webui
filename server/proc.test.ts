import { expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists, fileRange, readText, spawnProc, which } from './proc';
import { tempDir } from './testing/tempDir';

test('spawnProc pipes stdout and stderr and reports the exit code', async () => {
  const proc = spawnProc(['sh', '-c', 'echo out; echo err >&2; exit 3']);
  expect(proc.pid).toBeGreaterThan(0);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect([out, err]).toEqual(['out\n', 'err\n']);
  expect(proc.exitCode).toBe(3);
  expect(proc.signalCode).toBeNull();
});

test('a process killed by a signal has no exit code', async () => {
  const proc = spawnProc(['sh', '-c', 'kill -TERM $$'], { stdout: 'ignore', stderr: 'ignore' });
  expect(proc.stdout).toBeNull();
  await proc.exited;
  expect(proc.exitCode).toBeNull();
  expect(proc.signalCode).toBe('SIGTERM');
});

test('timeout kills the process with killSignal', async () => {
  const t0 = Date.now();
  const proc = spawnProc(['sleep', '5'], { timeout: 100, killSignal: 'SIGKILL' });
  await proc.exited;
  expect(proc.signalCode).toBe('SIGKILL');
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('kill() after the exit does not throw', async () => {
  const proc = spawnProc(['true']);
  await proc.exited;
  expect(() => proc.kill('SIGKILL')).not.toThrow();
});

test('cwd and env reach the process', async () => {
  using dir = tempDir('lw-proc-');
  const proc = spawnProc(['sh', '-c', 'pwd; echo $LW_X'], { cwd: dir.path, env: { ...process.env, LW_X: 'yes' } });
  expect(await new Response(proc.stdout).text()).toMatch(/lw-proc-.*\nyes\n$/);
});

test('a spawn failure throws at once, naming the binary and the cause', async () => {
  using dir = tempDir('lw-proc-');
  const plain = join(dir.path, 'plain');
  await writeFile(plain, '#!/bin/sh\n');
  await chmod(plain, 0o644);
  expect(() => spawnProc(['/nope/x'])).toThrow('spawn /nope/x ENOENT');
  expect(() => spawnProc(['no-such-bin-xyz'])).toThrow('spawn no-such-bin-xyz ENOENT');
  expect(() => spawnProc([plain])).toThrow(`spawn ${plain} EACCES`);
  expect(() => spawnProc(['sh'], { cwd: join(dir.path, 'missing') })).toThrow('spawn sh ENOENT');
  // The child's late 'error' event is swallowed: nothing escapes as an unhandled error.
  await new Promise((r) => setTimeout(r, 20));
});

test('a spawn failure is diagnosed with the PATH of the child environment, a directory is not executable', async () => {
  using dir = tempDir('lw-proc-');
  const tool = join(dir.path, 'tool');
  await writeFile(tool, '#!/bin/sh\n');
  await chmod(tool, 0o755);
  // Found in the parent's PATH, missing from the child's: the child cannot start it.
  const env = { ...process.env, PATH: join(dir.path, 'empty') };
  const parentPath = process.env.PATH;
  process.env.PATH = `${dir.path}:${parentPath}`;
  try {
    expect(() => spawnProc(['tool'], { env })).toThrow('spawn tool ENOENT');
  } finally {
    process.env.PATH = parentPath;
  }
  expect(() => spawnProc([dir.path])).toThrow(`spawn ${dir.path} EACCES`);
  await new Promise((r) => setTimeout(r, 20));
});

test('an error event after the start (a failed kill) does not crash the process', async () => {
  const proc = spawnProc(['sleep', '5']);
  const child = (proc as unknown as { child: import('node:child_process').ChildProcess }).child;
  // Node reports a kill() failure other than ESRCH as an 'error' event: without a listener, emit() throws.
  expect(() => child.emit('error', new Error('kill EPERM'))).not.toThrow();
  proc.kill('SIGKILL');
  await proc.exited;
});

test('which looks the binary up in the PATH', async () => {
  expect(which('sh')).toMatch(/^\/.*\/sh$/);
  expect(which('no-such-bin-xyz')).toBeNull();
  expect(which('/bin/sh')).toBe('/bin/sh');
  using dir = tempDir('lw-proc-');
  await mkdir(join(dir.path, 'tool'));
  expect(which('tool', `${dir.path}`)).toBeNull(); // a directory is not a binary
});

test('fileRange reads [start, end)', async () => {
  using dir = tempDir('lw-proc-');
  const p = join(dir.path, 'f');
  await writeFile(p, '0123456789');
  expect(await new Response(fileRange(p, 2, 5)).text()).toBe('234');
  expect(await new Response(fileRange(p, 0, 0)).text()).toBe('');
});

test('fileRange reads in 1 MiB chunks, so the disk speed check is not held back by the stream', async () => {
  using dir = tempDir('lw-proc-');
  const p = join(dir.path, 'big');
  await writeFile(p, new Uint8Array(4 << 20));
  const sizes: number[] = [];
  for await (const chunk of fileRange(p, 0, 4 << 20)) sizes.push(chunk.byteLength);
  expect(sizes[0]).toBe(1 << 20);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(4 << 20);
});

test('fileExists is true for a file only, readText reads UTF-8', async () => {
  using dir = tempDir('lw-proc-');
  const p = join(dir.path, 'f');
  await writeFile(p, 'é\n');
  expect(await fileExists(p)).toBe(true);
  expect(await fileExists(dir.path)).toBe(false);
  expect(await fileExists(join(dir.path, 'missing'))).toBe(false);
  expect(await readText(p)).toBe('é\n');
  await expect(readText(join(dir.path, 'missing'))).rejects.toThrow();
});
