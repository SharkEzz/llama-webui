import { createHash, type Hash } from 'node:crypto';
import { mkdir, open, rename, rm, rmdir, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DownloadFile,
  type DownloadItem,
  type DownloadLive,
  type DownloadStatus,
  isDownloadActive,
} from '@llama-webui/shared';
import type { DownloadInput, DownloadsRepo } from '../db/downloads';
import { HttpError, notFound } from '../http';
import { fileRange } from '../proc';
import { fmtBytes, GiB } from '../tuning/memory';
import { type HfClient, hfHttpError } from './client';
import { fileDest, partPath, sizeOf } from './paths';

export interface DownloadQueueDeps {
  repo: DownloadsRepo;
  hf: Pick<HfClient, 'auth' | 'endpoint' | 'headers'>;
  onItem(item: DownloadItem): void;
  onLive(live: DownloadLive | null): void;
  onDeleted(ids: number[]): void;
  fetch?: typeof fetch;
  /** Free bytes on the filesystem holding `dir` (null: unknown, no check). */
  freeBytes?: (dir: string) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Pauses between attempts after a network error (2, 4, 8, 16, 30 s). */
  retryDelaysMs?: number[];
  /** An attempt with no data for this long is restarted (60 s). */
  stallMs?: number;
  /** Interval of the live progress messages (250 ms). */
  liveEveryMs?: number;
  /** Space left free on top of the downloads (1 GiB). */
  marginBytes?: number;
}

/** Transient failure (network, 5xx, 408, 429, stall, truncated file): the attempt is retried. */
class Retryable extends Error {}
/** 416: the `.part` does not match the file any more; deleted, then retried from the start. */
class RangeRejected extends Retryable {}

/** sha256 of the first `bytes` of a file's `.part`: kept across the attempts of an item, so a retry does not re-read it. */
interface HashState {
  path: string;
  hasher: Hash;
  bytes: number;
}

interface Current {
  id: number;
  ac: AbortController;
  canceled: boolean;
  live: DownloadLive;
  /** Bytes received during the current attempt (resets the retry budget). */
  progressed: boolean;
  lastEmit: number;
  lastBytes: number;
  hash: HashState | null;
}

const isEnospc = (e: unknown) => (e as { code?: string })?.code === 'ENOSPC';

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Free space on the filesystem of `dir`, or of its nearest existing parent (the folder may not exist yet). */
export async function freeBytesOf(dir: string): Promise<number | null> {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const s = await statfs(d);
      return s.bavail * s.bsize;
    } catch {
      if (dirname(d) === d) return null;
    }
  }
}

/**
 * The Hugging Face download queue, one item at a time. Each file goes to `<file>.part` (resumed with a Range
 * request after an error or a restart), is checked against its sha256 then renamed into place. dispose() stops the
 * transfer without touching the `.part` or the database row: the next start resumes it.
 */
export class DownloadQueue {
  private current: Current | null = null;
  private loopP: Promise<void> | null = null;
  /** Work was added since the loop last looked at the queue. */
  private dirty = false;
  private disposed = false;
  /** Serializes enqueue() and retry(): the already-queued and disk space checks must see each other's rows. */
  private serial: Promise<unknown> = Promise.resolve();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private readonly retryDelaysMs: number[];
  private readonly stallMs: number;
  private readonly liveEveryMs: number;
  private readonly marginBytes: number;

  constructor(private readonly deps: DownloadQueueDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
    this.freeBytes = deps.freeBytes ?? freeBytesOf;
    this.retryDelaysMs = deps.retryDelaysMs ?? [2000, 4000, 8000, 16_000, 30_000];
    this.stallMs = deps.stallMs ?? 60_000;
    this.liveEveryMs = deps.liveEveryMs ?? 250;
    this.marginBytes = deps.marginBytes ?? GiB;
  }

  get live(): DownloadLive | null {
    return this.current?.live ?? null;
  }

  /** Waits for the queue to go idle (tests). */
  async idle(): Promise<void> {
    while (this.loopP) await this.loopP;
  }

  /** Resumes the items left queued or downloading (startup). */
  resume(): void {
    this.kick();
  }

  /**
   * Queues downloads. Files already in place (same size) are left out, a variant with nothing left is skipped;
   * refuses a variant already in the queue, or a total that does not fit on the disk.
   */
  enqueue(inputs: DownloadInput[]): Promise<DownloadItem[]> {
    return this.exclusive(async () => {
      const seen = new Set<string>();
      for (const i of inputs) {
        if (seen.has(i.key)) throw new HttpError(400, `${i.name} is listed twice`);
        seen.add(i.key);
        this.refuseQueued(i.repo, i.key, i.name);
      }

      const todo: DownloadInput[] = [];
      let need = 0;
      for (const i of inputs) {
        const left = await this.remaining(i.dir, i.files);
        need += left.bytes;
        if (left.files.length > 0) todo.push({ ...i, files: left.files });
      }
      if (todo.length === 0) return [];
      await this.checkSpace(todo[0]!.dir, need);

      const items = todo.map((i) => this.deps.repo.create(i));
      for (const item of items) this.deps.onItem(item);
      this.kick();
      return items;
    });
  }

  /** Cancels a queued or running item: its partial and finished files are deleted. */
  async cancel(id: number): Promise<void> {
    const item = this.deps.repo.get(id);
    if (!item) throw notFound('Download');
    if (!isDownloadActive(item.status)) throw new HttpError(409, 'This download is not running', 'not-active');
    if (this.current?.id === id) {
      this.current.canceled = true;
      this.current.ac.abort(new Error('canceled'));
      return;
    }
    // Out of the queue first: the loop must not pick it up while its files are being deleted.
    const canceled = this.deps.repo.setStatus(id, 'canceled', { finished: true });
    try {
      await this.discard(item);
    } finally {
      // Canceled either way: the other clients must stop showing it as queued (a failed delete still answers 500).
      this.deps.onItem(canceled);
    }
  }

  /** Removes a finished item from the list (its files stay). */
  remove(id: number): void {
    const item = this.deps.repo.get(id);
    if (!item) throw notFound('Download');
    if (isDownloadActive(item.status)) throw new HttpError(409, 'Cancel this download first', 'active');
    this.deps.repo.delete(id);
    this.deps.onDeleted([id]);
  }

  /**
   * Puts a failed or canceled item back in the queue. Its files are checked on disk again when it runs (a canceled
   * item's were deleted): those still in place are kept.
   */
  retry(id: number): Promise<DownloadItem> {
    return this.exclusive(async () => {
      const item = this.deps.repo.get(id);
      if (!item) throw notFound('Download');
      if (item.status !== 'error' && item.status !== 'canceled')
        throw new HttpError(409, 'Only a failed or canceled download can be retried', 'not-finished');
      this.refuseQueued(item.repo, item.key, item.name);
      await this.checkSpace(item.dir, (await this.remaining(item.dir, item.files)).bytes);
      const next = this.deps.repo.requeue(id);
      this.deps.onItem(next);
      this.kick();
      return next;
    });
  }

  clearFinished(): number[] {
    const ids = this.deps.repo.clearFinished();
    if (ids.length > 0) this.deps.onDeleted(ids);
    return ids;
  }

  /** Shutdown: stops the transfer, keeps the `.part` and the row (“downloading”) for the next start. */
  dispose(): void {
    this.disposed = true;
    this.current?.ac.abort(new Error('disposed'));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.serial.then(fn, fn);
    this.serial = run.catch(() => {});
    return run;
  }

  private refuseQueued(repo: string, key: string, name: string): void {
    if (this.deps.repo.active().some((a) => a.repo === repo && a.key === key))
      throw new HttpError(409, `${name} is already in the download queue`, 'already-queued');
  }

  /** The files not in place yet (same size), and the bytes they still need (their `.part` counts as written). */
  private async remaining<F extends { path: string; size: number }>(dir: string, files: F[]) {
    const left: F[] = [];
    let bytes = 0;
    for (const f of files) {
      const dest = fileDest(dir, f.path);
      if ((await sizeOf(dest)) === f.size) continue;
      left.push(f);
      bytes += f.size - Math.min((await sizeOf(partPath(dest))) ?? 0, f.size);
    }
    return { files: left, bytes };
  }

  /** Refuses `need` bytes more if they do not fit next to what the queue still has to write (507). */
  private async checkSpace(dir: string, need: number): Promise<void> {
    // What the queue ahead still has to write lands on the same disk most of the time.
    for (const a of this.deps.repo.active()) need += Math.max(0, a.totalBytes - a.bytesDone);
    const free = await this.freeBytes(dir);
    if (free !== null && free < need + this.marginBytes)
      throw new HttpError(
        507,
        `Not enough disk space: ${fmtBytes(need)} to download (plus ${fmtBytes(this.marginBytes)} margin), ${fmtBytes(free)} free`,
        'disk-full',
      );
  }

  private kick(): void {
    this.dirty = true;
    if (this.loopP || this.disposed) return;
    // process() handles its own errors: what gets here (the database failing…) is logged, the item is resumed later.
    const p = this.loop().catch((e: unknown) => console.error('[llama-webui] download queue stopped:', e));
    this.loopP = p;
    void p.finally(() => {
      if (this.loopP === p) this.loopP = null;
      // Something was queued after the loop's last look: go again.
      if (this.dirty && !this.disposed) this.kick();
    });
  }

  private async loop(): Promise<void> {
    while (!this.disposed) {
      this.dirty = false;
      const next = this.deps.repo.next();
      if (!next) return;
      await this.process(next);
    }
  }

  private setLive(cur: Current, patch: Partial<DownloadLive>): void {
    if (this.disposed || this.current !== cur) return;
    cur.live = { ...cur.live, ...patch };
    this.deps.onLive(cur.live);
  }

  /** Called for every chunk: only builds (and emits) a new DownloadLive once per `liveEveryMs`. */
  private progress(cur: Current, bytes: number): void {
    const t = this.now();
    const dt = t - cur.lastEmit;
    if (dt < this.liveEveryMs) return;
    const inst = ((bytes - cur.lastBytes) * 1000) / dt;
    cur.lastEmit = t;
    cur.lastBytes = bytes;
    this.setLive(cur, {
      phase: 'downloading',
      bytesDone: bytes,
      bps: cur.live.bps > 0 ? 0.7 * cur.live.bps + 0.3 * inst : inst,
      retryAt: null,
    });
  }

  private finish(id: number, status: DownloadStatus, o: { error?: string; code?: string | null } = {}): void {
    if (this.disposed) return;
    this.deps.onItem(this.deps.repo.setStatus(id, status, { ...o, finished: true }));
  }

  /** Deletes what a canceled item wrote: `.part` files and files it had already put in place. */
  private async discard(item: DownloadItem): Promise<void> {
    for (const f of item.files) {
      const dest = fileDest(item.dir, f.path);
      await rm(partPath(dest), { force: true });
      if (f.done || (await sizeOf(dest)) === f.size) await rm(dest, { force: true });
    }
    // Then the folders left empty, deepest first: shard subfolders, the repo's, the org's (rmdir fails if not empty).
    const dirs = new Set(item.files.map((f) => dirname(fileDest(item.dir, f.path))));
    dirs.add(item.dir).add(dirname(item.dir));
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => {});
  }

  private async process(start: DownloadItem): Promise<void> {
    const doneBytes = (files: DownloadFile[]) => files.reduce((a, f) => a + (f.done ? f.size : 0), 0);
    const cur: Current = {
      id: start.id,
      ac: new AbortController(),
      canceled: false,
      live: {
        id: start.id,
        phase: 'downloading',
        file: start.files.find((f) => !f.done)?.path ?? '',
        bytesDone: doneBytes(start.files),
        totalBytes: start.totalBytes,
        bps: 0,
        retryAt: null,
      },
      progressed: false,
      lastEmit: this.now(),
      lastBytes: doneBytes(start.files),
      hash: null,
    };
    this.current = cur;
    let item = start.status === 'downloading' ? start : this.deps.repo.setStatus(start.id, 'downloading');
    this.deps.onItem(item);
    this.deps.onLive(cur.live);
    try {
      for (const file of item.files) {
        if (file.done) continue;
        await this.withRetries(cur, item, file, doneBytes(item.files));
        if (this.disposed) return;
        // Canceled while the file was being checked or renamed: the attempt did not look at the signal again.
        if (cur.canceled) throw cur.ac.signal.reason;
        item = this.deps.repo.fileDone(item.id, file.path);
      }
      this.finish(item.id, 'done');
    } catch (e) {
      if (this.disposed) return;
      if (cur.canceled) {
        await this.discard(item).catch(() => {});
        this.finish(item.id, 'canceled');
        return;
      }
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message ?? String(e), 'download-failed');
      console.error(`[llama-webui] download ${item.repo}/${item.key} failed: ${err.message}`);
      this.finish(item.id, 'error', { error: err.message, code: err.code ?? null });
    } finally {
      if (this.current === cur) this.current = null;
      if (!this.disposed) this.deps.onLive(null);
    }
  }

  private async withRetries(cur: Current, item: DownloadItem, file: DownloadFile, base: number): Promise<void> {
    let failures = 0;
    for (;;) {
      cur.progressed = false;
      try {
        await this.fetchFile(cur, item, file, base);
        return;
      } catch (e) {
        if (cur.ac.signal.aborted || !(e instanceof Retryable)) throw e;
        if (cur.progressed) failures = 0;
        const delay = this.retryDelaysMs[failures++];
        if (delay === undefined) throw new HttpError(502, e.message, 'hf-unreachable');
        console.warn(`[llama-webui] download ${item.repo}/${file.path}: ${e.message}, retrying`);
        this.setLive(cur, { phase: 'retrying', retryAt: this.now() + delay, bps: 0 });
        await this.sleep(delay, cur.ac.signal);
      }
    }
  }

  /** One attempt at one file: resume the `.part`, check the sha256, rename into place. */
  private async fetchFile(cur: Current, item: DownloadItem, file: DownloadFile, base: number): Promise<void> {
    const dest = fileDest(item.dir, file.path);
    const part = partPath(dest);
    if (cur.ac.signal.aborted) throw cur.ac.signal.reason;
    // Already in place: a stop between the rename and the database write that records it.
    if ((await sizeOf(dest)) === file.size) return;
    await mkdir(dirname(dest), { recursive: true });
    let offset = (await sizeOf(part)) ?? 0;
    if (offset > file.size) {
      await rm(part, { force: true });
      offset = 0;
    }
    this.setLive(cur, { phase: 'downloading', file: file.path, bytesDone: base + offset, retryAt: null });
    const hash = file.sha256 ? await this.hashOf(cur, file.path, part, offset) : null;
    if (offset < file.size) await this.transfer(cur, item, file, part, offset, hash, base);

    const size = (await sizeOf(part)) ?? 0;
    if (size !== file.size) {
      // Short (the body ended early): kept and resumed. Too long: it cannot be this file.
      if (size > file.size) await rm(part, { force: true });
      throw new Retryable(`${file.path}: got ${size} of ${file.size} bytes`);
    }
    cur.hash = null;
    if (hash && hash.hasher.digest('hex') !== file.sha256) {
      await rm(part, { force: true });
      throw new HttpError(422, `Checksum mismatch for ${file.path}: the file was deleted`, 'checksum-mismatch');
    }
    await rename(part, dest);
  }

  /**
   * The sha256 state of the first `offset` bytes of the `.part`: the one of the previous attempt if it covers exactly
   * them, else read again from the disk (after a restart, or a write that failed half-way).
   */
  private async hashOf(cur: Current, path: string, part: string, offset: number): Promise<HashState> {
    const kept = cur.hash;
    if (kept && kept.path === path && kept.bytes === offset) return kept;
    cur.hash = null;
    const hash: HashState = { path, hasher: createHash('sha256'), bytes: 0 };
    if (offset > 0) {
      this.setLive(cur, { phase: 'verifying', bps: 0, retryAt: null });
      for await (const chunk of fileRange(part, 0, offset)) {
        if (cur.ac.signal.aborted) throw cur.ac.signal.reason;
        hash.hasher.update(chunk);
        hash.bytes += chunk.byteLength;
      }
    }
    cur.hash = hash;
    return hash;
  }

  /** GET of the file from `offset`, appended to the `.part` (and to `hash`, which follows what is on disk). */
  private async transfer(
    cur: Current,
    item: DownloadItem,
    file: DownloadFile,
    part: string,
    offset: number,
    hash: HashState | null,
    base: number,
  ): Promise<void> {
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(new Error('stalled')), this.stallMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error('stalled')), this.stallMs);
    };
    const signal = AbortSignal.any([cur.ac.signal, stall.signal]);
    const fail = (e: unknown): Error => {
      if (cur.ac.signal.aborted) return cur.ac.signal.reason as Error;
      if (stall.signal.aborted) return new Retryable(`no data for ${Math.round(this.stallMs / 1000)} s`);
      if (isEnospc(e)) return new HttpError(507, 'Disk full', 'disk-full');
      if (e instanceof HttpError || e instanceof Retryable) return e;
      return new Retryable((e as Error).message ?? String(e));
    };
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const res = await this.request(item, file, offset, signal);
      let start = offset;
      if (res.status === 206) {
        const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
        if (!m || Number(m[1]) !== offset) {
          await res.body?.cancel();
          await rm(part, { force: true });
          throw new Retryable(`${file.path}: unexpected range in the response`);
        }
      } else if (offset > 0) {
        // The server ignored the Range header: start over.
        start = 0;
        if (hash) {
          hash.hasher = createHash('sha256');
          hash.bytes = 0;
        }
      }
      fh = await open(part, start > 0 ? 'a' : 'w');
      let written = start;
      cur.lastEmit = this.now();
      cur.lastBytes = base + written;
      this.setLive(cur, { phase: 'downloading', bytesDone: base + written, retryAt: null });
      if (!res.body) throw new Retryable(`${file.path}: empty response`);
      for await (const chunk of res.body) {
        bump();
        // Written first: a chunk that failed to land on disk must not be hashed.
        await fh.write(chunk);
        if (hash) {
          hash.hasher.update(chunk);
          hash.bytes += chunk.byteLength;
        }
        written += chunk.byteLength;
        cur.progressed = true;
        this.progress(cur, base + written);
      }
    } catch (e) {
      if (e instanceof RangeRejected) await rm(part, { force: true });
      throw fail(e);
    } finally {
      clearTimeout(timer);
      await fh?.close();
    }
  }

  /**
   * Opens `/resolve/<sha>/<path>`, following redirects by hand: the token is only sent to the Hugging Face
   * endpoint, never to the CDN the file is served from (signed URL, re-requested on every attempt as it expires).
   */
  private async request(item: DownloadItem, file: DownloadFile, offset: number, signal: AbortSignal) {
    const { token } = await this.deps.hf.auth();
    const endpoint = this.deps.hf.endpoint;
    const origin = new URL(endpoint).origin;
    const range: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
    let url = `${endpoint}/${item.repo}/resolve/${item.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      try {
        res = await this.fetch(url, {
          headers: this.deps.hf.headers(new URL(url).origin === origin ? token : null, range),
          redirect: 'manual',
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Retryable(`Hugging Face unreachable: ${(e as Error).message}`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url).href;
        continue;
      }
      if (res.status === 200 || res.status === 206) return res;
      await res.body?.cancel();
      if (res.status === 416) throw new RangeRejected(`${file.path}: range not satisfiable`);
      const err = hfHttpError(res, { repo: item.repo, hasToken: token !== null });
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Retryable(err.message);
      throw err;
    }
    throw new HttpError(502, 'Too many redirects from Hugging Face', 'hf-unreachable');
  }
}
