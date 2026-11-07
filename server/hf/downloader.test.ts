import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DownloadItem, DownloadLive } from '@llama-webui/shared';
import type { DownloadInput } from '../db/downloads';
import { DownloadsRepo } from '../db/downloads';
import { openDb } from '../db/open';
import { HttpError } from '../http';
import { type TempDir, tempDir } from '../testing/tempDir';
import { HfClient } from './client';
import { DownloadQueue, type Handover } from './downloader';

const ENDPOINT = 'https://hf.test';
const SHA = 'a'.repeat(40);
const data = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex');

interface CdnCall {
  path: string;
  range: string | null;
  signal: AbortSignal;
}
/** Replaces the next CDN response (null: served normally). */
type Override = (c: CdnCall) => Response | null;

/** A fake Hub (`/resolve` redirects to the CDN) and CDN (Range support), with injectable failures. */
function fakeHub(files: Record<string, Uint8Array>) {
  const calls: { url: string; auth: string | null; range: string | null }[] = [];
  const next: Override[] = [];
  let resolveStatus: number | null = null;
  const serve = (path: string, range: string | null): Response => {
    const body = files[path];
    if (!body) return new Response('', { status: 404 });
    const m = range && /^bytes=(\d+)-$/.exec(range);
    if (!m) return new Response(body, { status: 200 });
    const start = Number(m[1]);
    if (start >= body.length) return new Response('', { status: 416 });
    return new Response(body.slice(start), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` },
    });
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    // Like fetch: an aborted signal rejects at once.
    if (init.signal?.aborted) throw init.signal.reason;
    const h = new Headers(init.headers);
    calls.push({ url, auth: h.get('authorization'), range: h.get('range') });
    const u = new URL(url);
    if (u.origin === ENDPOINT) {
      if (resolveStatus) return new Response('', { status: resolveStatus });
      const m = /^\/o\/r\/resolve\/[0-9a-f]{40}\/(.+)$/.exec(u.pathname);
      if (!m) return new Response('', { status: 404 });
      return new Response(null, { status: 302, headers: { location: `https://cdn.test/${m[1]}?sig=1` } });
    }
    const path = decodeURIComponent(u.pathname.slice(1));
    const override = next.shift()?.({ path, range: h.get('range'), signal: init.signal! });
    return override ?? serve(path, h.get('range'));
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    calls,
    cdnCalls: () => calls.filter((c) => c.url.startsWith('https://cdn.test/')),
    /** Queues CDN behaviors for the next requests. */
    script: (...o: Override[]) => next.push(...o),
    failResolve: (status: number | null) => {
      resolveStatus = status;
    },
  };
}

/** A body that sends `head` then stops: an error after it, or a hang until the request is aborted. */
function cut(head: Uint8Array, signal: AbortSignal, o: { hang?: boolean } = {}): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(head);
          return;
        }
        if (!o.hang) return c.error(new Error('connection reset'));
        // Pending until the request is aborted (error() drops queued chunks: only once `head` was read).
        return new Promise<void>((resolve) => {
          const stop = () => {
            c.error(new DOMException('aborted', 'AbortError'));
            resolve();
          };
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        });
      },
    }),
    { status: 200 },
  );
}

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await Bun.sleep(5);
  }
  throw new Error('timed out');
};

const dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) d[Symbol.dispose]();
});

function setup(files: Record<string, Uint8Array>, o: { free?: number; dbPath?: string; handover?: Handover } = {}) {
  const tmp = tempDir('lw-dl-');
  dirs.push(tmp);
  const repoDir = join(tmp.path, 'o', 'r');
  const hub = fakeHub(files);
  const make = (dbPath = o.dbPath ?? ':memory:') => {
    const repo = new DownloadsRepo(openDb(dbPath));
    const onItem = mock((_: DownloadItem) => {});
    const onLive = mock((_: DownloadLive | null) => {});
    const onDeleted = mock((_: number[]) => {});
    const queue = new DownloadQueue({
      repo,
      hf: new HfClient({ env: { HF_ENDPOINT: ENDPOINT, HF_TOKEN: 'hf_secret' }, fetch: hub.fetch }),
      fetch: hub.fetch,
      onItem,
      onLive,
      onDeleted,
      freeBytes: async () => o.free ?? null,
      sleep: async () => {},
      liveEveryMs: 0,
      marginBytes: 0,
      handover: o.handover ?? { idle: Promise.resolve() },
    });
    return { repo, queue, onItem, onLive, onDeleted };
  };
  const input = (key: string, paths: string[] = [key]): DownloadInput => ({
    repo: 'o/r',
    revision: SHA,
    key,
    name: key.replace(/\.gguf$/, ''),
    quant: null,
    kind: 'model',
    dir: repoDir,
    files: paths.map((p) => ({ path: p, size: files[p]!.length, sha256: sha256(files[p]!) })),
  });
  const file = (p: string) => Bun.file(join(repoDir, p));
  return { hub, make, input, file, repoDir, tmp };
}

/** Statuses broadcast for item `id`, in order. */
const statuses = (onItem: { mock: { calls: [DownloadItem][] } }, id: number) =>
  onItem.mock.calls
    .map(([i]) => i)
    .filter((i) => i.id === id)
    .map((i) => i.status);

describe('DownloadQueue', () => {
  test('downloads every shard, checks it and renames it into place; the token never reaches the CDN', async () => {
    const files = { 'Q8/m-00001-of-00002.gguf': data(3000, 1), 'Q8/m-00002-of-00002.gguf': data(2000, 2) };
    const s = setup(files);
    const { queue, onItem, onLive, repo } = s.make();
    const [item] = await queue.enqueue([s.input('Q8/m-00001-of-00002.gguf', Object.keys(files))]);
    await queue.idle();
    expect(statuses(onItem, item!.id)).toEqual(['queued', 'downloading', 'done']);
    expect(repo.get(item!.id)).toMatchObject({ status: 'done', bytesDone: 5000, totalBytes: 5000 });
    for (const [p, b] of Object.entries(files)) expect(new Uint8Array(await s.file(p).arrayBuffer())).toEqual(b);
    expect(await s.file('Q8/m-00001-of-00002.gguf.part').exists()).toBe(false);
    expect(onLive).toHaveBeenLastCalledWith(null);
    expect(onLive).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading', bytesDone: 5000 }));
    const resolve = s.hub.calls.filter((c) => c.url.startsWith(ENDPOINT));
    expect(resolve.map((c) => c.url)).toEqual([
      `${ENDPOINT}/o/r/resolve/${SHA}/Q8/m-00001-of-00002.gguf`,
      `${ENDPOINT}/o/r/resolve/${SHA}/Q8/m-00002-of-00002.gguf`,
    ]);
    expect(resolve.every((c) => c.auth === 'Bearer hf_secret')).toBe(true);
    expect(s.hub.cdnCalls().every((c) => c.auth === null)).toBe(true);
  });

  test('resumes an existing .part with a Range request', async () => {
    const body = data(4000);
    const s = setup({ 'm.gguf': body });
    await Bun.write(join(s.repoDir, 'm.gguf.part'), body.slice(0, 1500));
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(item!.id)!.status).toBe('done');
    expect(s.hub.cdnCalls().map((c) => c.range)).toEqual(['bytes=1500-']);
    expect(new Uint8Array(await s.file('m.gguf').arrayBuffer())).toEqual(body);
  });

  test('starts over when the server ignores the Range header', async () => {
    const body = data(4000);
    const s = setup({ 'm.gguf': body });
    await Bun.write(join(s.repoDir, 'm.gguf.part'), body.slice(0, 1500));
    s.hub.script(() => new Response(body, { status: 200 }));
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(item!.id)!.status).toBe('done');
    expect(new Uint8Array(await s.file('m.gguf').arrayBuffer())).toEqual(body);
  });

  test('a connection cut mid-file is resumed where it stopped', async () => {
    const body = data(5000);
    const s = setup({ 'm.gguf': body });
    s.hub.script((c) => cut(body.slice(0, 2000), c.signal));
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(item!.id)!.status).toBe('done');
    expect(s.hub.cdnCalls().map((c) => c.range)).toEqual([null, 'bytes=2000-']);
    expect(new Uint8Array(await s.file('m.gguf').arrayBuffer())).toEqual(body);
  });

  test('a body that ends early without an error is resumed, not started over; the hash is not read again', async () => {
    const body = data(5000);
    const s = setup({ 'm.gguf': body });
    s.hub.script(() => new Response(body.slice(0, 2000), { status: 200 }));
    const { queue, repo, onLive } = s.make();
    const [item] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(item!.id)!.status).toBe('done');
    expect(s.hub.cdnCalls().map((c) => c.range)).toEqual([null, 'bytes=2000-']);
    expect(onLive.mock.calls.some(([l]) => l?.phase === 'verifying')).toBe(false);
    expect(new Uint8Array(await s.file('m.gguf').arrayBuffer())).toEqual(body);
  });

  test('network errors are retried, then the item fails once the retries are spent', async () => {
    const s = setup({ 'm.gguf': data(100) });
    const down = () => {
      throw new TypeError('fetch failed');
    };
    s.hub.script(down, down);
    const { queue, repo, onLive } = s.make();
    const [ok] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(ok!.id)!.status).toBe('done');
    expect(onLive.mock.calls.filter(([l]) => l?.phase === 'retrying')).toHaveLength(2);

    s.hub.script(...Array.from({ length: 6 }, () => down));
    await Bun.file(join(s.repoDir, 'm.gguf')).delete();
    const [ko] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(ko!.id)).toMatchObject({ status: 'error', code: 'hf-unreachable' });
  });

  test('a gated repo fails at once, with its code', async () => {
    const s = setup({ 'm.gguf': data(100) });
    s.hub.failResolve(403);
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([s.input('m.gguf')]);
    await queue.idle();
    expect(repo.get(item!.id)).toMatchObject({ status: 'error', code: 'hf-gated' });
    expect(s.hub.calls).toHaveLength(1);
  });

  test('a checksum mismatch deletes the file', async () => {
    const s = setup({ 'm.gguf': data(1000) });
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([
      { ...s.input('m.gguf'), files: [{ path: 'm.gguf', size: 1000, sha256: 'f'.repeat(64) }] },
    ]);
    await queue.idle();
    expect(repo.get(item!.id)).toMatchObject({ status: 'error', code: 'checksum-mismatch' });
    expect(await s.file('m.gguf').exists()).toBe(false);
    expect(await s.file('m.gguf.part').exists()).toBe(false);
  });

  test('cancel: a running item stops and its files are deleted; a queued one never starts', async () => {
    const files = { 'a.gguf': data(3000, 1), 'b.gguf': data(1000, 2) };
    const s = setup(files);
    s.hub.script((c) => cut(files['a.gguf'].slice(0, 1000), c.signal, { hang: true }));
    const { queue, repo, onItem } = s.make();
    const [a, b] = await queue.enqueue([s.input('a.gguf'), s.input('b.gguf')]);
    await until(async () => (await s.file('a.gguf.part').size) === 1000);
    expect(queue.live).toMatchObject({ id: a!.id, bytesDone: 1000 });
    await queue.cancel(b!.id);
    expect(repo.get(b!.id)!.status).toBe('canceled');
    await queue.cancel(a!.id);
    await queue.idle();
    expect(statuses(onItem, a!.id).at(-1)).toBe('canceled');
    expect(await s.file('a.gguf.part').exists()).toBe(false);
    expect(existsSync(s.repoDir)).toBe(false); // the folders it created are gone too
    expect(s.hub.cdnCalls().map((c) => new URL(c.url).pathname)).toEqual(['/a.gguf']);
    await queue.retry(a!.id);
    await queue.idle();
    expect(repo.get(a!.id)!.status).toBe('done');
    await expect(queue.cancel(a!.id)).rejects.toThrow(HttpError);
  });

  test('retrying a canceled split model downloads again the shards the cancel deleted', async () => {
    const files = { 'm-00001-of-00002.gguf': data(1000, 1), 'm-00002-of-00002.gguf': data(3000, 2) };
    const s = setup(files);
    s.hub.script(
      () => null,
      (c) => cut(files['m-00002-of-00002.gguf'].slice(0, 500), c.signal, { hang: true }),
    );
    const { queue, repo } = s.make();
    const [item] = await queue.enqueue([s.input('m-00001-of-00002.gguf', Object.keys(files))]);
    await until(async () => (await s.file('m-00002-of-00002.gguf.part').size) === 500);
    expect(repo.get(item!.id)!.files[0]!.done).toBe(true);
    await queue.cancel(item!.id);
    await queue.idle();
    expect(await s.file('m-00001-of-00002.gguf').exists()).toBe(false);
    await queue.retry(item!.id);
    await queue.idle();
    expect(repo.get(item!.id)).toMatchObject({ status: 'done', bytesDone: 4000 });
    for (const [p, b] of Object.entries(files)) expect(new Uint8Array(await s.file(p).arrayBuffer())).toEqual(b);
  });

  test('concurrent or repeated requests for one variant queue it once; retry refuses a variant already queued', async () => {
    const s = setup({ 'm.gguf': data(1000) });
    const { queue, repo } = s.make();
    await expect(queue.enqueue([s.input('m.gguf'), s.input('m.gguf')])).rejects.toMatchObject({ status: 400 });
    s.hub.script((c) => cut(data(1000).slice(0, 10), c.signal, { hang: true }));
    const both = await Promise.allSettled([queue.enqueue([s.input('m.gguf')]), queue.enqueue([s.input('m.gguf')])]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(repo.active()).toHaveLength(1);
    const [running] = repo.active();
    // An older failed item for the same variant cannot be put back next to it.
    const old = repo.setStatus(repo.create(s.input('m.gguf')).id, 'error', { finished: true });
    await expect(queue.retry(old.id)).rejects.toMatchObject({ code: 'already-queued' });
    await queue.cancel(running!.id);
    await queue.idle();
  });

  test('retry checks the disk space like a new download', async () => {
    const s = setup({ 'm.gguf': data(1000) }, { free: 500 });
    const { queue, repo } = s.make();
    const failed = repo.setStatus(repo.create(s.input('m.gguf')).id, 'error', { code: 'disk-full', finished: true });
    await expect(queue.retry(failed.id)).rejects.toMatchObject({ status: 507, code: 'disk-full' });
    expect(repo.get(failed.id)!.status).toBe('error');
  });

  test('refuses a duplicate and a download that does not fit on the disk; skips files already there', async () => {
    const files = { 'm.gguf': data(1000), 'n.gguf': data(500) };
    const s = setup(files, { free: 1200 });
    const { queue, repo } = s.make();
    await expect(queue.enqueue([s.input('m.gguf'), s.input('n.gguf')])).rejects.toMatchObject({
      status: 507,
      code: 'disk-full',
    });
    expect(repo.list()).toHaveLength(0);
    await Bun.write(join(s.repoDir, 'n.gguf'), files['n.gguf']);
    s.hub.script((c) => cut(files['m.gguf'].slice(0, 10), c.signal, { hang: true }));
    const created = await queue.enqueue([s.input('m.gguf'), s.input('n.gguf')]);
    expect(created.map((i) => i.key)).toEqual(['m.gguf']);
    await expect(queue.enqueue([s.input('m.gguf')])).rejects.toMatchObject({ code: 'already-queued' });
    await queue.cancel(created[0]!.id);
    await queue.idle();
  });

  test('remove and clear finished items', async () => {
    const s = setup({ 'm.gguf': data(10), 'n.gguf': data(10, 3) });
    const { queue, repo, onDeleted } = s.make();
    const [m, n] = await queue.enqueue([s.input('m.gguf'), s.input('n.gguf')]);
    await queue.idle();
    queue.remove(m!.id);
    expect(queue.clearFinished()).toEqual([n!.id]);
    expect(onDeleted).toHaveBeenNthCalledWith(1, [m!.id]);
    expect(onDeleted).toHaveBeenNthCalledWith(2, [n!.id]);
    expect(repo.list()).toEqual([]);
    expect(await s.file('m.gguf').exists()).toBe(true);
  });

  test('after a restart (or a reload), the next queue resumes the item from its .part', async () => {
    const body = data(6000);
    const handover: Handover = { idle: Promise.resolve() };
    const tmpDb = tempDir('lw-dl-db-');
    dirs.push(tmpDb);
    const s = setup({ 'm.gguf': body }, { dbPath: join(tmpDb.path, 'db.sqlite'), handover });
    s.hub.script((c) => cut(body.slice(0, 2500), c.signal, { hang: true }));
    const first = s.make();
    const [item] = await first.queue.enqueue([s.input('m.gguf')]);
    await until(async () => (await s.file('m.gguf.part').size) === 2500);
    first.queue.dispose();
    const second = s.make();
    expect(second.repo.get(item!.id)!.status).toBe('downloading');
    second.queue.resume();
    await first.queue.idle();
    await second.queue.idle();
    expect(second.repo.get(item!.id)!.status).toBe('done');
    expect(s.hub.cdnCalls().map((c) => c.range)).toEqual([null, 'bytes=2500-']);
    expect(new Uint8Array(await s.file('m.gguf').arrayBuffer())).toEqual(body);
    // The disposed queue wrote nothing after it let go.
    expect(statuses(first.onItem, item!.id)).toEqual(['queued', 'downloading']);
    expect(first.onLive).not.toHaveBeenLastCalledWith(null);
  });
});
