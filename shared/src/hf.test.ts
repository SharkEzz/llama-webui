import { describe, expect, test } from 'bun:test';
import { DownloadRequestSchema, parseHfInput, vramFit } from './hf';

describe('parseHfInput', () => {
  test('empty and free text', () => {
    expect(parseHfInput('  ')).toEqual({ kind: 'empty' });
    expect(parseHfInput('qwen3 0.6b')).toEqual({ kind: 'query', q: 'qwen3 0.6b' });
    expect(parseHfInput('gemma')).toEqual({ kind: 'query', q: 'gemma' });
  });

  test('repo id, with an optional quantization', () => {
    expect(parseHfInput(' unsloth/Qwen3-0.6B-GGUF ')).toEqual({
      kind: 'repo',
      repo: 'unsloth/Qwen3-0.6B-GGUF',
      file: null,
      quant: null,
    });
    expect(parseHfInput('unsloth/Qwen3-0.6B-GGUF:Q4_K_M')).toEqual({
      kind: 'repo',
      repo: 'unsloth/Qwen3-0.6B-GGUF',
      file: null,
      quant: 'Q4_K_M',
    });
  });

  test('Hugging Face URLs', () => {
    expect(parseHfInput('https://huggingface.co/unsloth/Qwen3-0.6B-GGUF')).toMatchObject({
      kind: 'repo',
      repo: 'unsloth/Qwen3-0.6B-GGUF',
      file: null,
    });
    expect(parseHfInput('huggingface.co/unsloth/Qwen3-0.6B-GGUF/tree/main')).toMatchObject({
      repo: 'unsloth/Qwen3-0.6B-GGUF',
      file: null,
    });
    expect(
      parseHfInput('https://huggingface.co/unsloth/Big-GGUF/blob/main/Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf'),
    ).toMatchObject({ repo: 'unsloth/Big-GGUF', file: 'Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf' });
    expect(parseHfInput('https://hf.co/org/repo/resolve/abc/model.gguf?download=true')).toMatchObject({
      repo: 'org/repo',
      file: 'model.gguf',
    });
  });

  test('site pages and other repo types are searches', () => {
    expect(parseHfInput('https://huggingface.co/models?library=gguf').kind).toBe('query');
    expect(parseHfInput('https://huggingface.co/datasets/org/data').kind).toBe('query');
    expect(parseHfInput('https://example.com/org/repo').kind).toBe('query');
  });
});

describe('vramFit', () => {
  const GIB = 1024 ** 3;
  test('thresholds', () => {
    expect(vramFit(10 * GIB, 24 * GIB)).toBe('fits');
    expect(vramFit(22 * GIB, 24 * GIB)).toBe('tight');
    expect(vramFit(30 * GIB, 24 * GIB)).toBe('offload');
  });
  test('no GPU', () => expect(vramFit(GIB, 0)).toBeNull());
});

describe('DownloadRequestSchema', () => {
  const ok = { repo: 'org/repo', revision: 'a'.repeat(40), keys: ['model.gguf'] };
  test('accepts a request', () => expect(DownloadRequestSchema.parse(ok)).toEqual(ok));
  test('rejects a bad repo, revision or empty keys', () => {
    expect(() => DownloadRequestSchema.parse({ ...ok, repo: '../etc' })).toThrow();
    expect(() => DownloadRequestSchema.parse({ ...ok, revision: 'main' })).toThrow();
    expect(() => DownloadRequestSchema.parse({ ...ok, keys: [] })).toThrow();
    expect(() => DownloadRequestSchema.parse({ ...ok, extra: 1 })).toThrow();
  });
});
