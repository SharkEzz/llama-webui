import type { Database } from 'bun:sqlite';
import type { DownloadFile, DownloadItem, DownloadStatus } from '@llama-webui/shared';

interface Row {
  id: number;
  repo: string;
  revision: string;
  variant_key: string;
  name: string;
  quant: string | null;
  kind: 'model' | 'mmproj';
  dir: string;
  files_json: string;
  status: DownloadStatus;
  bytes_done: number;
  total_bytes: number;
  error: string | null;
  code: string | null;
  created_at: number;
  finished_at: number | null;
}

export type DownloadInput = Pick<DownloadItem, 'repo' | 'revision' | 'key' | 'name' | 'quant' | 'kind' | 'dir'> & {
  files: Omit<DownloadFile, 'done'>[];
};

const toItem = (r: Row): DownloadItem => ({
  id: r.id,
  repo: r.repo,
  revision: r.revision,
  key: r.variant_key,
  name: r.name,
  quant: r.quant,
  kind: r.kind,
  dir: r.dir,
  files: JSON.parse(r.files_json),
  status: r.status,
  bytesDone: r.bytes_done,
  totalBytes: r.total_bytes,
  error: r.error,
  code: r.code,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const FINISHED = "('done', 'error', 'canceled')";

/** The Hugging Face download queue (`downloads`): queued, running and finished items. */
export class DownloadsRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: DownloadInput): DownloadItem {
    const files: DownloadFile[] = input.files.map((f) => ({ ...f, done: false }));
    const row = this.db
      .query<Row, (string | number | null)[]>(
        `INSERT INTO downloads(repo, revision, variant_key, name, quant, kind, dir, files_json, status, total_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING *`,
      )
      .get(
        input.repo,
        input.revision,
        input.key,
        input.name,
        input.quant,
        input.kind,
        input.dir,
        JSON.stringify(files),
        files.reduce((a, f) => a + f.size, 0),
        this.now(),
      )!;
    return toItem(row);
  }

  get(id: number): DownloadItem | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM downloads WHERE id = ?').get(id);
    return row ? toItem(row) : null;
  }

  /** Every item, oldest first. */
  list(): DownloadItem[] {
    return this.db.query<Row, []>('SELECT * FROM downloads ORDER BY id').all().map(toItem);
  }

  /** Queued or downloading items, in queue order. */
  active(): DownloadItem[] {
    return this.db
      .query<Row, []>("SELECT * FROM downloads WHERE status IN ('queued', 'downloading') ORDER BY id")
      .all()
      .map(toItem);
  }

  /** The next item to process: one left “downloading” (interrupted) first, else the oldest queued one. */
  next(): DownloadItem | null {
    const row = this.db
      .query<Row, []>(
        "SELECT * FROM downloads WHERE status IN ('queued', 'downloading') ORDER BY status = 'downloading' DESC, id LIMIT 1",
      )
      .get();
    return row ? toItem(row) : null;
  }

  setStatus(
    id: number,
    status: DownloadStatus,
    o: { error?: string | null; code?: string | null; finished?: boolean } = {},
  ): DownloadItem {
    this.db.run('UPDATE downloads SET status = ?, error = ?, code = ?, finished_at = ? WHERE id = ?', [
      status,
      o.error ?? null,
      o.code ?? null,
      o.finished ? this.now() : null,
      id,
    ]);
    return this.get(id)!;
  }

  /** Marks a file as downloaded (renamed into place); `bytes_done` = size of the finished files. */
  fileDone(id: number, path: string): DownloadItem {
    const item = this.get(id)!;
    const files = item.files.map((f) => (f.path === path ? { ...f, done: true } : f));
    const bytes = files.reduce((a, f) => a + (f.done ? f.size : 0), 0);
    this.db.run('UPDATE downloads SET files_json = ?, bytes_done = ? WHERE id = ?', [JSON.stringify(files), bytes, id]);
    return this.get(id)!;
  }

  /**
   * Back to the queue (retry). No file is trusted as done any more (a canceled item's were deleted, others may have
   * been since): the queue checks each one on disk again and skips those still in place.
   */
  requeue(id: number): DownloadItem {
    const item = this.get(id)!;
    const files = item.files.map((f) => ({ ...f, done: false }));
    this.db.run('UPDATE downloads SET files_json = ?, bytes_done = 0 WHERE id = ?', [JSON.stringify(files), id]);
    return this.setStatus(id, 'queued');
  }

  delete(id: number): void {
    this.db.run('DELETE FROM downloads WHERE id = ?', [id]);
  }

  /** Deletes the finished items (done, failed, canceled); returns their ids. */
  clearFinished(): number[] {
    return this.db
      .query<{ id: number }, []>(`DELETE FROM downloads WHERE status IN ${FINISHED} RETURNING id`)
      .all()
      .map((r) => r.id)
      .sort((a, b) => a - b);
  }
}
