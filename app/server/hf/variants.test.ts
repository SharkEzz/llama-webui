import { assert, describe, it } from '@effect/vitest';
import { Array as Arr } from 'effect';
import { groupRepoFiles } from './variants.ts';

const f = (path: string, size = 10) => ({ path, size, sha256: null });

describe('groupRepoFiles', () => {
  it('groupRepoFiles: single files, shard sets, projectors; other files ignored; smallest first', () => {
    const { variants, projectors } = groupRepoFiles([
      f('.gitattributes', 1),
      f('README.md', 1),
      f('Model-BF16.gguf', 100),
      f('Model-Q4_K_M.gguf', 30),
      f('Q8_0/Model-Q8_0-00002-of-00002.gguf', 40),
      f('Q8_0/Model-Q8_0-00001-of-00002.gguf', 40),
      f('mmproj-F16.gguf', 5),
      f('mmproj-BF16.gguf', 5),
      f('imatrix.dat', 3),
    ]);
    assert.deepStrictEqual(
      Arr.map(variants, (v) => [v.key, v.name, v.quant, v.totalBytes, v.files.length]),
      [
        ['Model-Q4_K_M.gguf', 'Model-Q4_K_M', 'Q4_K_M', 30, 1],
        ['Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Model-Q8_0', 'Q8_0', 80, 2],
        ['Model-BF16.gguf', 'Model-BF16', 'BF16', 100, 1],
      ],
    );
    assert.deepStrictEqual(
      Arr.map(variants[1]?.files ?? [], (x) => x.path),
      ['Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Q8_0/Model-Q8_0-00002-of-00002.gguf'],
    );
    assert.deepStrictEqual(
      Arr.map(variants, (v) => v.kind),
      ['model', 'model', 'model'],
    );
    assert.deepStrictEqual(
      Arr.map(projectors, (v) => [v.key, v.kind, v.quant]),
      [
        ['mmproj-BF16.gguf', 'mmproj', 'BF16'],
        ['mmproj-F16.gguf', 'mmproj', 'F16'],
      ],
    );
  });

  it('imatrix files in GGUF format are not offered as variants (#31)', () => {
    const { variants, projectors } = groupRepoFiles([
      f('Model-Q4_K_M.gguf', 30),
      f('imatrix.gguf', 3),
      f('imatrix_unsloth.gguf', 3),
      f('Q8_0/imatrix-Model.gguf', 3),
    ]);
    assert.deepStrictEqual(
      Arr.map(variants, (v) => v.key),
      ['Model-Q4_K_M.gguf'],
    );
    assert.deepStrictEqual(projectors, []);
  });
});
