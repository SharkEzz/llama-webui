import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('Node imports the package from its sources, without a build', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('@llama-webui/shared')"], {
    cwd: join(import.meta.dirname, '../../../app'),
    encoding: 'utf8',
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
});
