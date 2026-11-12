import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ModelCacheRepo } from '../db/modelCache';
import { openDb } from '../db/open';
import { tempDir } from '../testing/tempDir';
import { writeFileDeep } from '../testing/write';
import { readModel } from './gguf';
import { type KvValue, writeGguf } from './gguf.fixture';
import { groupGgufFiles, scanModels } from './scan';

const tmp = tempDir('lw-scan-');
afterAll(() => tmp[Symbol.dispose]());
const dir = tmp.path;
const str = (value: string): KvValue => ({ type: 'string', value });
const u32 = (value: number): KvValue => ({ type: 'u32', value });

test('groupGgufFiles groups shards under the first and reports missing ones', () => {
  expect(groupGgufFiles(['a/Big-00002-of-00003.gguf', 'small.gguf', 'a/Big-00001-of-00003.gguf'])).toEqual([
    {
      main: 'a/Big-00001-of-00003.gguf',
      files: ['a/Big-00001-of-00003.gguf', 'a/Big-00002-of-00003.gguf'],
      missing: ['a/Big-00003-of-00003.gguf'],
    },
    { main: 'small.gguf', files: ['small.gguf'], missing: [] },
  ]);
});

test('scanModels skips hidden dirs, classifies mmproj, reports unreadable files and reuses the cache', async () => {
  const tensors = [{ name: 'token_embd.weight', shape: [8, 4], bytes: 128 }];
  await writeGguf(
    join(dir, 'model.gguf'),
    { 'general.architecture': str('llama'), 'llama.block_count': u32(1) },
    tensors,
  );
  await writeGguf(
    join(dir, 'mm.gguf'),
    { 'general.architecture': str('clip'), 'general.type': str('mmproj') },
    tensors,
  );
  mkdirSync(join(dir, '.cache'));
  await writeGguf(join(dir, '.cache', 'x.gguf'), { 'general.architecture': str('llama') }, tensors);
  await writeFileDeep(join(dir, 'bad.gguf'), 'not a gguf');
  await writeFileDeep(join(dir, 'notes.txt'), 'rien');

  const cache = new ModelCacheRepo(openDb(':memory:'));
  let reads = 0;
  const read = (p: string) => {
    reads++;
    return readModel(p);
  };
  const first = await scanModels(dir, { cache, read });
  expect(reads).toBe(3);
  expect(first.map((e) => [e.relPath, e.ok, e.ok ? e.kind : null])).toEqual([
    ['bad.gguf', false, null],
    ['mm.gguf', true, 'mmproj'],
    ['model.gguf', true, 'model'],
  ]);
  expect(first[0]!.ok ? '' : first[0]!.error).toContain('unreadable GGUF');

  reads = 0;
  const second = await scanModels(dir, { cache, read });
  expect(reads).toBe(1);
  expect(second).toEqual(first);
});
