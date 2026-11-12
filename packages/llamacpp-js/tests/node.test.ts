import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { benchBinary, findLlamaServerPid, loadFlags, parseCmdline, portFromArgv } from '../src/node.ts';
import { TESTDATA } from './helpers.ts';

test('benchBinary sits next to the server binary', () => {
  assert.equal(benchBinary('/x/bin/llama-server'), '/x/bin/llama-bench');
  assert.equal(benchBinary('llama-server'), 'llama-bench');
  assert.equal(benchBinary('testdata/fake/fake-llama-server'), 'testdata/fake/fake-llama-bench');
});

test('parseCmdline and portFromArgv read a /proc cmdline', () => {
  const argv = parseCmdline('llama-server\0-m\0a.gguf\0--port\x009090\0');
  assert.deepEqual(argv, ['llama-server', '-m', 'a.gguf', '--port', '9090']);
  assert.equal(portFromArgv(argv), 9090);
  assert.equal(portFromArgv(['llama-server', '--port=8181']), 8181);
  assert.equal(portFromArgv(['llama-server']), 8080);
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
    assert.equal(await findLlamaServerPid(9090, root), 12);
    assert.equal(await findLlamaServerPid(8080, root), 11);
    assert.equal(await findLlamaServerPid(7000, root), null);
    assert.equal(await findLlamaServerPid(8080, join(root, 'missing')), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadFlags reads the --help of a binary, null when it cannot run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llamacpp-js-bin-'));
  try {
    // A stand-in binary that prints the captured --help.
    const bin = join(dir, 'llama-server');
    await writeFile(bin, `#!/bin/sh\ncat ${JSON.stringify(join(TESTDATA, 'llama-server-help.txt'))}\n`);
    await chmod(bin, 0o755);
    const catalog = await loadFlags(bin);
    assert.equal(catalog?.flags.length, 47);
    assert.equal(catalog?.byName.has('--ctx-size'), true);
    assert.equal(await loadFlags(join(dir, 'missing')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
