import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { HttpError } from '../http';
import { tempDir } from '../testing/tempDir';
import { writeFileDeep } from '../testing/write';
import { HfClient } from './client';
import { fileDest, repoDir } from './paths';
import { hfEndpoint, hfTokenPath, resolveHfToken } from './token';
import { groupRepoFiles } from './variants';

describe('token', () => {
  test('HF_TOKEN first, then the hf token file', async () => {
    using dir = tempDir('lw-hf-');
    await writeFileDeep(join(dir.path, 'hf', 'token'), ' hf_file \n');
    const env = { HF_HOME: join(dir.path, 'hf') };
    expect(await resolveHfToken({ ...env, HF_TOKEN: 'hf_env' })).toEqual({ token: 'hf_env', source: 'env' });
    expect(await resolveHfToken({ ...env, HUGGING_FACE_HUB_TOKEN: 'hf_old' })).toEqual({
      token: 'hf_old',
      source: 'env',
    });
    expect(await resolveHfToken(env)).toEqual({ token: 'hf_file', source: 'file' });
    expect(await resolveHfToken({ HF_HOME: join(dir.path, 'none') })).toEqual({ token: null, source: null });
  });

  test('token file location follows the hf CLI', () => {
    expect(hfTokenPath({}, '/home/u')).toBe('/home/u/.cache/huggingface/token');
    expect(hfTokenPath({ XDG_CACHE_HOME: '/c' }, '/home/u')).toBe('/c/huggingface/token');
    expect(hfTokenPath({ HF_HOME: '/h' }, '/home/u')).toBe('/h/token');
    expect(hfTokenPath({ HF_TOKEN_PATH: '/t', HF_HOME: '/h' }, '/home/u')).toBe('/t');
  });

  test('endpoint', () => {
    expect(hfEndpoint({})).toBe('https://huggingface.co');
    expect(hfEndpoint({ HF_ENDPOINT: 'https://mirror.example/' })).toBe('https://mirror.example');
  });
});

describe('paths', () => {
  test('downloads go to <modelsDir>/<org>/<name>', () => {
    expect(repoDir('/m', 'unsloth/Qwen3-GGUF')).toBe('/m/unsloth/Qwen3-GGUF');
    expect(fileDest('/m/o/r', 'Q4_K_M/a-00001-of-00002.gguf')).toBe('/m/o/r/Q4_K_M/a-00001-of-00002.gguf');
  });
  test('a path cannot leave the repo folder', () => {
    expect(() => repoDir('/m', '../x')).toThrow(HttpError);
    expect(() => fileDest('/m/o/r', '../../etc/passwd')).toThrow(HttpError);
    expect(() => fileDest('/m/o/r', '/etc/passwd')).toThrow(HttpError);
    expect(() => fileDest('/m/o/r', '')).toThrow(HttpError);
  });
});

describe('groupRepoFiles', () => {
  const f = (path: string, size = 10) => ({ path, size, sha256: null });
  test('single files, shard sets, projectors; other files ignored; smallest first', () => {
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
    expect(variants.map((v) => [v.key, v.name, v.quant, v.totalBytes, v.files.length])).toEqual([
      ['Model-Q4_K_M.gguf', 'Model-Q4_K_M', 'Q4_K_M', 30, 1],
      ['Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Model-Q8_0', 'Q8_0', 80, 2],
      ['Model-BF16.gguf', 'Model-BF16', 'BF16', 100, 1],
    ]);
    expect(variants[1]!.files.map((x) => x.path)).toEqual([
      'Q8_0/Model-Q8_0-00001-of-00002.gguf',
      'Q8_0/Model-Q8_0-00002-of-00002.gguf',
    ]);
    expect(projectors.map((v) => [v.key, v.kind, v.quant])).toEqual([
      ['mmproj-BF16.gguf', 'mmproj', 'BF16'],
      ['mmproj-F16.gguf', 'mmproj', 'F16'],
    ]);
  });
});

test('imatrix files in GGUF format are not offered as variants (#31)', () => {
  const f = (path: string, size: number) => ({ path, size, sha256: null });
  const { variants, projectors } = groupRepoFiles([
    f('Model-Q4_K_M.gguf', 30),
    f('imatrix.gguf', 3),
    f('imatrix_unsloth.gguf', 3),
    f('Q8_0/imatrix-Model.gguf', 3),
  ]);
  expect(variants.map((v) => v.key)).toEqual(['Model-Q4_K_M.gguf']);
  expect(projectors).toEqual([]);
});

describe('HfClient', () => {
  const client = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, env = {}) => {
    const calls: { url: string; auth: string | null }[] = [];
    const c = new HfClient({
      env: { HF_ENDPOINT: 'https://hf.test', HF_TOKEN: 'hf_secret', ...env },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get('authorization') });
        return handler(url, init);
      }) as typeof fetch,
    });
    return { c, calls };
  };

  test('repo files: sizes and sha256 from the blobs listing, pinned commit', async () => {
    const { c, calls } = client(() =>
      Response.json({
        id: 'o/r',
        sha: 'a'.repeat(40),
        gated: 'manual',
        siblings: [
          { rfilename: 'README.md', size: 12 },
          { rfilename: 'm.gguf', size: 99, lfs: { sha256: 'abc', size: 99 } },
        ],
      }),
    );
    expect(await c.repoFiles('o/r')).toEqual({
      id: 'o/r',
      sha: 'a'.repeat(40),
      gated: true,
      files: [
        { path: 'README.md', size: 12, sha256: null },
        { path: 'm.gguf', size: 99, sha256: 'abc' },
      ],
    });
    expect(calls).toEqual([
      { url: 'https://hf.test/api/models/o/r/revision/main?blobs=true', auth: 'Bearer hf_secret' },
    ]);
  });

  test('search: GGUF filter, most downloaded first', async () => {
    const { c, calls } = client(() =>
      Response.json([{ id: 'o/r', downloads: 5, likes: 2, gated: false, lastModified: '2026-01-01T00:00:00.000Z' }]),
    );
    expect(await c.search('qwen 3')).toEqual([
      { id: 'o/r', downloads: 5, likes: 2, gated: false, lastModified: '2026-01-01T00:00:00.000Z' },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/models');
    expect(url.searchParams.get('search')).toBe('qwen 3');
    expect(url.searchParams.get('filter')).toBe('gguf');
    expect(url.searchParams.get('sort')).toBe('downloads');
  });

  test('errors carry a code', async () => {
    const code = async (res: () => Response) =>
      client(res)
        .c.repoFiles('o/r')
        .then(
          () => null,
          (e: HttpError) => e.code,
        );
    expect(await code(() => new Response('', { status: 401, headers: { 'x-error-code': 'GatedRepo' } }))).toBe(
      'hf-gated',
    );
    expect(await code(() => new Response('', { status: 401, headers: { 'x-error-code': 'RepoNotFound' } }))).toBe(
      'hf-not-found',
    );
    expect(await code(() => new Response('', { status: 404 }))).toBe('hf-not-found');
    expect(await code(() => new Response('', { status: 401 }))).toBe('hf-unauthorized');
    expect(await code(() => new Response('', { status: 429 }))).toBe('hf-rate-limited');
    expect(await code(() => new Response('', { status: 503 }))).toBe('hf-unreachable');
    // A proxy answering 200 with a page: the Hub is the problem, not the client's JSON.
    expect(await code(() => new Response('<html>', { status: 200 }))).toBe('hf-unreachable');
    expect(
      await client(() => {
        throw new TypeError('fetch failed');
      })
        .c.repoFiles('o/r')
        .catch((e: HttpError) => e.code),
    ).toBe('hf-unreachable');
  });

  test('status: token source and account, a rejected token is reported', async () => {
    const ok = client(() => Response.json({ name: 'alice' }));
    expect(await ok.c.status()).toEqual({
      token: 'env',
      user: 'alice',
      tokenInvalid: false,
      endpoint: 'https://hf.test',
    });
    await ok.c.status();
    expect(ok.calls).toHaveLength(1); // cached per token
    const bad = client(() => new Response('', { status: 401 }));
    expect(await bad.c.status()).toMatchObject({ token: 'env', user: null, tokenInvalid: true });
    using dir = tempDir('lw-hf-');
    const none = client(() => Response.json({}), { HF_TOKEN: '', HF_HOME: dir.path });
    expect(await none.c.status()).toMatchObject({ token: null, user: null, tokenInvalid: false });
    expect(none.calls).toHaveLength(0);
  });
});
