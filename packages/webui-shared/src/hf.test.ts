import { Exit, Option, Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { issuesOf } from './api/errors.ts';
import { DownloadRequest, parseHfInput, vramFit } from './hf.ts';
import { STRICT } from './profile.ts';

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

  test('a malformed escape in a URL does not throw', () => {
    expect(parseHfInput('huggingface.co/org/name/blob/main/model%2')).toEqual({
      kind: 'repo',
      repo: 'org/name',
      file: 'model%2',
      quant: null,
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
  const decode = Schema.decodeUnknownExit(DownloadRequest, STRICT);
  /** The messages of a request that must not decode. */
  const messages = (input: unknown) => {
    const error = Exit.findErrorOption(decode(input));
    if (Option.isNone(error)) throw new Error('expected the request to be refused');
    return issuesOf(error.value.issue).map((issue) => issue.message);
  };
  test('accepts a request', () => expect(decode(ok)).toEqual(Exit.succeed(ok)));
  test('rejects a bad repo, revision or empty keys', () => {
    expect(messages({ ...ok, repo: '../etc' })).toEqual(['Repository id expected (org/name)']);
    expect(messages({ ...ok, revision: 'main' })).toEqual(['Commit sha expected']);
    expect(messages({ ...ok, keys: [] })).toHaveLength(1);
    expect(messages({ ...ok, keys: Array.from({ length: 17 }, (_, i) => `m${i}.gguf`) })).toHaveLength(1);
    expect(messages({ ...ok, keys: [''] })).toHaveLength(1);
    expect(messages({ ...ok, extra: 1 })).toEqual(['unknown key']);
  });
});
