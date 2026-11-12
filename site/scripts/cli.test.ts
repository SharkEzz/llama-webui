import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('a script takes its flags after the -- that npm habits add (pnpm passes it through)', async () => {
  // `pnpm site:preview -- --port 0`: the script sees `-- --port 0`.
  const child = spawn(process.execPath, [join(import.meta.dirname, 'serve.ts'), '--', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c: Buffer) => {
    out += c;
    if (out.includes('Serving dist/')) child.kill();
  });
  child.stderr.on('data', (c: Buffer) => {
    out += c;
  });
  await once(child, 'exit');
  expect(out).toContain('Serving dist/');
});
