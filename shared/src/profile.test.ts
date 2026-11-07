import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseProfileImport } from './profile';

test('llama-tui import: whole config', async () => {
  const raw = await Bun.file(join(import.meta.dir, '../../testdata/llama-tui-config.json')).json();
  const r = parseProfileImport(raw);
  expect(r.profiles.map((p) => p.name)).toEqual(['qwen3.8-27b-mtp', 'qwen3.8-27b-mtp (optimisé) (optimisé)']);
  expect(r.rejected).toEqual([]);
});

test('import: valid ones kept, invalid ones explained', () => {
  const r = parseProfileImport({
    profiles: [
      { name: 'ok', model: 'm.gguf' },
      { name: 'no-model' },
      { name: 'reserved', model: 'm.gguf', args: ['--port', '9000'] },
      { name: 'ok', model: 'other.gguf' },
    ],
  });
  expect(r.profiles.map((p) => p.name)).toEqual(['ok']);
  expect(r.rejected.map((x) => x.name)).toEqual(['no-model', 'reserved', 'ok']);
  expect(r.rejected[1]!.reason).toContain('--port is managed by llama-webui');
});

test('import: single profile and array', () => {
  expect(parseProfileImport({ name: 'a', model: 'm' }).profiles).toHaveLength(1);
  expect(
    parseProfileImport([
      { name: 'a', model: 'm' },
      { name: 'b', model: 'm' },
    ]).profiles,
  ).toHaveLength(2);
});
