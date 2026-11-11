// Runs the library under Node (≥ 24, which strips the types itself): `node packages/llamacpp-js/scripts/node-smoke.ts`.
// The unit tests run on Bun; this checks that Node loads the sources as they are and that the runtime parts (fetch,
// streams, child_process, fs) work there too, against a local HTTP server and a fake binary.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchLlama,
  fetchProps,
  LlamaStreamError,
  parseBenchJson,
  parseHelp,
  probeHealth,
  probeLlamaServer,
  probeUrl,
  streamChatCompletion,
} from '../src/index.ts';
import { findLlamaServerPid, loadFlags } from '../src/node.ts';

const TESTDATA = join(import.meta.dirname, '../../../testdata');
const fixture = (name: string) => readFile(join(TESTDATA, name), 'utf8');

// Parsers, on the captured outputs the unit tests use.
const help = await fixture('llama-server-help.txt');
assert.equal(parseHelp(help).flags.length, 47);
assert.equal(parseBenchJson(await fixture('llama-bench/ok.json'))?.build, 'b12119 (6f1e65437)');

// HTTP client, against a fake llama-server.
const metrics = await fixture('metrics-after.txt');
const slots = await fixture('slots-busy.json');
const server = createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  if (req.url === '/slots') return res.writeHead(200, { 'content-type': 'application/json' }).end(slots);
  if (req.url === '/metrics') return res.writeHead(200).end(metrics);
  if (req.url === '/props') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"total_slots":1}');
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (JSON.parse(body).fail) return res.end(`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const base = probeUrl('127.0.0.1', port);
try {
  assert.equal(await probeHealth(port, fetch, '127.0.0.1'), 200);
  assert.equal(await probeLlamaServer(port, fetch, '127.0.0.1'), true);
  const raw = await fetchLlama(base);
  assert.equal(raw.health, 'ok');
  assert.ok(raw.slots && raw.slots.length > 0);
  assert.ok(raw.metrics && raw.metrics.size > 0);
  assert.deepEqual(await fetchProps(base), { total_slots: 1 });
  const text: string[] = [];
  for await (const c of streamChatCompletion(base, { messages: [] })) text.push(c.choices?.[0]?.delta?.content ?? '');
  assert.deepEqual(text, ['Hi']);
  await assert.rejects(async () => {
    for await (const _ of streamChatCompletion(base, { fail: true }));
  }, LlamaStreamError);
} finally {
  server.close();
}

// Process helpers: a fake binary printing the captured --help, and /proc.
const dir = await mkdtemp(join(tmpdir(), 'llamacpp-js-smoke-'));
try {
  const bin = join(dir, 'llama-server');
  await writeFile(bin, `#!/bin/sh\ncat ${JSON.stringify(join(TESTDATA, 'llama-server-help.txt'))}\n`);
  await chmod(bin, 0o755);
  assert.equal((await loadFlags(bin))?.flags.length, 47);
  assert.equal(await loadFlags(join(dir, 'missing')), null);
  assert.equal(await findLlamaServerPid(1, join(dir, 'no-proc')), null);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`node-smoke: ok (Node ${process.versions.node})`);
