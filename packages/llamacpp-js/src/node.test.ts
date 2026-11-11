import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchBinary, findLlamaServerPid, loadFlags, parseCmdline, portFromArgv } from './node.ts';

const TESTDATA = join(import.meta.dir, '../../../testdata');

test('benchBinary sits next to the server binary', () => {
  expect(benchBinary('/x/bin/llama-server')).toBe('/x/bin/llama-bench');
  expect(benchBinary('llama-server')).toBe('llama-bench');
  expect(benchBinary('testdata/fake/fake-llama-server')).toBe('testdata/fake/fake-llama-bench');
});

test('parseCmdline and portFromArgv read a /proc cmdline', () => {
  const argv = parseCmdline('llama-server\0-m\0a.gguf\0--port\x009090\0');
  expect(argv).toEqual(['llama-server', '-m', 'a.gguf', '--port', '9090']);
  expect(portFromArgv(argv)).toBe(9090);
  expect(portFromArgv(['llama-server', '--port=8181'])).toBe(8181);
  expect(portFromArgv(['llama-server'])).toBe(8080);
});

test('findLlamaServerPid finds the llama-server on the port in a /proc tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llamacpp-js-proc-'));
  const proc = async (pid: string, cmdline: string) => {
    await mkdir(join(root, pid));
    await writeFile(join(root, pid, 'cmdline'), cmdline);
  };
  try {
    await proc('10', '/usr/bin/bash\0');
    await proc('11', '/opt/llama/llama-server\0--port\x008080\0');
    await proc('12', '/opt/llama/llama-server\0--port\x009090\0');
    await mkdir(join(root, 'self'));
    expect(await findLlamaServerPid(9090, root)).toBe(12);
    expect(await findLlamaServerPid(8080, root)).toBe(11);
    expect(await findLlamaServerPid(7000, root)).toBeNull();
    expect(await findLlamaServerPid(8080, join(root, 'missing'))).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadFlags reads the --help of a binary, null when it cannot run', async () => {
  const catalog = await loadFlags(join(TESTDATA, 'fake/fake-llama-server'));
  expect(catalog?.byName.has('--ctx-size')).toBe(true);
  expect(await loadFlags(join(TESTDATA, 'does-not-exist'))).toBeNull();
});
