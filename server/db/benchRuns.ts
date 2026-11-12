import type {
  BenchHardware,
  BenchKind,
  BenchRun,
  BenchSpec,
  BenchStatus,
  FitVerdict,
  Measure,
} from '@llama-webui/shared';
import type { Database } from './sqlite';

interface Row {
  id: number;
  kind: BenchKind;
  status: BenchStatus;
  model_path: string;
  profile_id: number | null;
  args_json: string;
  command: string;
  hardware_json: string;
  pp_tps: number | null;
  tg_tps: number | null;
  stats_json: string | null;
  vram_mib_json: string;
  error: string | null;
  log_excerpt: string;
  duration_ms: number | null;
  sweep_id: number | null;
  sweep_label: string | null;
  fit: FitVerdict | null;
  created_at: number;
}

interface Stats {
  pp: Measure | null;
  tg: Measure | null;
  draftAcceptPct: number | null;
  diskReadPeakBps?: number | null;
}

const NO_HARDWARE: BenchHardware = { cpu: '', gpus: [], build: null };

const toRun = (r: Row): BenchRun => {
  const stats: Stats = r.stats_json ? JSON.parse(r.stats_json) : { pp: null, tg: null, draftAcceptPct: null };
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    // The source profile may have been deleted since (profile_id ON DELETE SET NULL).
    spec: { ...JSON.parse(r.args_json), profileId: r.profile_id },
    command: r.command,
    hardware: r.hardware_json === '{}' ? NO_HARDWARE : JSON.parse(r.hardware_json),
    pp: stats.pp,
    tg: stats.tg,
    draftAcceptPct: stats.draftAcceptPct,
    vramPeak: JSON.parse(r.vram_mib_json),
    error: r.error,
    logExcerpt: r.log_excerpt,
    durationMs: r.duration_ms,
    diskReadPeakBps: stats.diskReadPeakBps ?? null,
    sweepId: r.sweep_id,
    sweepLabel: r.sweep_label,
    fit: r.fit,
    createdAt: r.created_at,
  };
};

/** Most runs one list returns: the default for a sweep (all its items), and the cap of an explicit `limit`. */
export const MAX_RUNS = 10_000;

export type BenchFinish = Partial<
  Pick<
    BenchRun,
    'status' | 'pp' | 'tg' | 'draftAcceptPct' | 'vramPeak' | 'error' | 'logExcerpt' | 'durationMs' | 'diskReadPeakBps'
  >
>;

export interface BenchFilter {
  kind?: BenchKind;
  modelPath?: string;
  status?: BenchStatus;
  /** "none" (default): outside sweeps; "all": all of them; an id: that sweep. */
  sweepId?: number | 'none' | 'all';
  /** 200 by default, `MAX_RUNS` for a sweep id. */
  limit?: number;
}

const ENDED_BADLY = "('failed', 'cancelled', 'interrupted')";

/** The benchmark runs (`bench_runs`), one-off or sweep items. */
export class BenchRunsRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(spec: BenchSpec, command: string, hardware: BenchHardware): BenchRun {
    const row = this.db
      .query<Row, (string | number | null)[]>(
        `INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command, hardware_json, vram_mib_json, created_at)
         VALUES (?, 'running', ?, (SELECT id FROM profiles WHERE id = ?), ?, ?, ?, '[]', ?) RETURNING *`,
      )
      .get(
        spec.kind,
        spec.modelPath,
        spec.profileId,
        JSON.stringify(spec),
        command,
        JSON.stringify(hardware),
        this.now(),
      )!;
    return toRun(row);
  }

  /** A sweep's items, queued (“queued”), in the given order. */
  enqueue(sweepId: number, items: { spec: BenchSpec; label: string; fit: FitVerdict }[]): BenchRun[] {
    const q = this.db.query<Row, (string | number | null)[]>(
      `INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command, hardware_json, vram_mib_json, sweep_id, sweep_label, fit, created_at)
       VALUES (?, 'queued', ?, (SELECT id FROM profiles WHERE id = ?), ?, '', '{}', '[]', ?, ?, ?, ?) RETURNING *`,
    );
    return this.db.transaction(() =>
      items.map((it) =>
        toRun(
          q.get(
            it.spec.kind,
            it.spec.modelPath,
            it.spec.profileId,
            JSON.stringify(it.spec),
            sweepId,
            it.label,
            it.fit,
            this.now(),
          )!,
        ),
      ),
    )();
  }

  /** A queued item starts: command and hardware frozen, launch date. */
  begin(id: number, o: { command: string; hardware: BenchHardware }): BenchRun {
    this.db.run(
      "UPDATE bench_runs SET status = 'running', command = ?, hardware_json = ?, created_at = ? WHERE id = ?",
      [o.command, JSON.stringify(o.hardware), this.now(), id],
    );
    return this.get(id)!;
  }

  nextQueued(sweepId: number): BenchRun | null {
    const row = this.db
      .query<Row, [number]>("SELECT * FROM bench_runs WHERE sweep_id = ? AND status = 'queued' ORDER BY id LIMIT 1")
      .get(sweepId);
    return row ? toRun(row) : null;
  }

  /** Puts an item back in the queue (Bun reloaded while it was running: it will be replayed). */
  requeue(id: number): void {
    this.db.run(
      "UPDATE bench_runs SET status = 'queued', error = NULL, stats_json = NULL, pp_tps = NULL, tg_tps = NULL, vram_mib_json = '[]', log_excerpt = '', duration_ms = NULL WHERE id = ?",
      [id],
    );
  }

  requeueInterrupted(sweepId: number): number {
    const ids = this.db
      .query<{ id: number }, [number]>("SELECT id FROM bench_runs WHERE sweep_id = ? AND status = 'interrupted'")
      .all(sweepId);
    for (const { id } of ids) this.requeue(id);
    return ids.length;
  }

  cancelQueued(sweepId: number): number {
    return this.db.run("UPDATE bench_runs SET status = 'cancelled' WHERE sweep_id = ? AND status = 'queued'", [sweepId])
      .changes;
  }

  finish(id: number, patch: BenchFinish): BenchRun {
    const cur = this.get(id);
    if (!cur) throw new Error(`run ${id} not found`);
    const next = { ...cur, ...patch };
    const stats: Stats = {
      pp: next.pp,
      tg: next.tg,
      draftAcceptPct: next.draftAcceptPct,
      diskReadPeakBps: next.diskReadPeakBps,
    };
    this.db.run(
      `UPDATE bench_runs SET status = ?, pp_tps = ?, tg_tps = ?, stats_json = ?, vram_mib_json = ?, error = ?, log_excerpt = ?, duration_ms = ?
       WHERE id = ?`,
      [
        next.status,
        next.pp?.tps ?? null,
        next.tg?.tps ?? null,
        JSON.stringify(stats),
        JSON.stringify(next.vramPeak),
        next.error,
        next.logExcerpt,
        next.durationMs,
        id,
      ],
    );
    return this.get(id)!;
  }

  list(f: BenchFilter = {}): BenchRun[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.kind) {
      where.push('kind = ?');
      args.push(f.kind);
    }
    if (f.modelPath) {
      where.push('model_path = ?');
      args.push(f.modelPath);
    }
    if (f.status) {
      where.push('status = ?');
      args.push(f.status);
    }
    const sweep = f.sweepId ?? 'none';
    if (sweep === 'none') where.push('sweep_id IS NULL');
    else if (sweep !== 'all') {
      where.push('sweep_id = ?');
      args.push(sweep);
    }
    const order = typeof sweep === 'number' ? 'id ASC' : 'created_at DESC, id DESC';
    const sql = `SELECT * FROM bench_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`;
    return this.db
      .query<Row, (string | number)[]>(sql)
      .all(...args, f.limit ?? (typeof sweep === 'number' ? MAX_RUNS : 200))
      .map(toRun);
  }

  /**
   * The latest successful one-off run of each profile (sweep items are left out: they test other settings than the
   * profile's own).
   */
  lastOkByProfile(): Map<number, BenchRun> {
    const rows = this.db
      .query<Row, []>(
        `SELECT * FROM bench_runs b WHERE b.id = (
           SELECT id FROM bench_runs WHERE profile_id = b.profile_id AND status = 'ok' AND sweep_id IS NULL
           ORDER BY created_at DESC, id DESC LIMIT 1)`,
      )
      .all();
    return new Map(rows.map((r) => [r.profile_id!, toRun(r)]));
  }

  get(id: number): BenchRun | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM bench_runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM bench_runs WHERE id = ?', [id]).changes > 0;
  }

  /** Deletes failed, cancelled or interrupted one-off runs; returns their ids (sweep runs stay). */
  deleteFailed(): number[] {
    return this.db
      .query<{ id: number }, []>(
        `DELETE FROM bench_runs WHERE sweep_id IS NULL AND status IN ${ENDED_BADLY} RETURNING id`,
      )
      .all()
      .map((r) => r.id);
  }

  /** On startup: a run left “running” (Bun stopped abruptly) becomes “interrupted”. */
  stopOrphans(): number {
    return this.db.run(
      "UPDATE bench_runs SET status = 'interrupted', error = COALESCE(error, 'interrupted (llama-webui stopped)') WHERE status = 'running'",
    ).changes;
  }
}
