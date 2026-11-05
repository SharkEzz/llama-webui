import type { Database } from "bun:sqlite";
import type { Sweep, SweepSpec, SweepStatus } from "@llama-webui/shared";

interface Row {
  id: number;
  name: string;
  status: SweepStatus;
  model_path: string;
  profile_id: number | null;
  spec_json: string;
  best_run_id: number | null;
  created_at: number;
  finished_at: number | null;
}

type Counts = Sweep["counts"];
const ZERO: Counts = { total: 0, queued: 0, running: 0, ok: 0, failed: 0, cancelled: 0, interrupted: 0 };

/** Les sweeps (`sweeps`) ; leurs éléments sont des runs de `bench_runs` (sweep_id). */
export class SweepsRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private counts(id: number): Counts {
    const c = { ...ZERO };
    for (const r of this.db.query<{ status: keyof Counts; n: number }, [number]>("SELECT status, count(*) n FROM bench_runs WHERE sweep_id = ? GROUP BY status").all(id)) {
      if (r.status in c) c[r.status] = r.n;
      c.total += r.n;
    }
    return c;
  }

  private toSweep(r: Row): Sweep {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      spec: { ...JSON.parse(r.spec_json), profileId: r.profile_id },
      bestRunId: r.best_run_id,
      counts: this.counts(r.id),
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  create(spec: SweepSpec): Sweep {
    const row = this.db
      .query<Row, (string | number | null)[]>(
        `INSERT INTO sweeps(name, status, model_path, profile_id, spec_json, created_at)
         VALUES (?, 'running', ?, (SELECT id FROM profiles WHERE id = ?), ?, ?) RETURNING *`,
      )
      .get(spec.name, spec.modelPath, spec.profileId, JSON.stringify(spec), this.now())!;
    return this.toSweep(row);
  }

  get(id: number): Sweep | null {
    const row = this.db.query<Row, [number]>("SELECT * FROM sweeps WHERE id = ?").get(id);
    return row ? this.toSweep(row) : null;
  }

  list(): Sweep[] {
    return this.db
      .query<Row, []>("SELECT * FROM sweeps ORDER BY created_at DESC, id DESC")
      .all()
      .map((r) => this.toSweep(r));
  }

  setStatus(id: number, status: SweepStatus, o: { bestRunId?: number | null; finishedAt?: number | null } = {}): Sweep {
    const sets = ["status = ?"];
    const args: (string | number | null)[] = [status];
    if (o.bestRunId !== undefined) (sets.push("best_run_id = ?"), args.push(o.bestRunId));
    if (o.finishedAt !== undefined) (sets.push("finished_at = ?"), args.push(o.finishedAt));
    this.db.run(`UPDATE sweeps SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
    return this.get(id)!;
  }

  /** Supprime le sweep et ses runs (cascade) ; renvoie les ids des runs supprimés. */
  delete(id: number): number[] {
    return this.db.transaction(() => {
      const ids = this.db.query<{ id: number }, [number]>("SELECT id FROM bench_runs WHERE sweep_id = ? ORDER BY id").all(id).map((r) => r.id);
      this.db.run("DELETE FROM sweeps WHERE id = ?", [id]);
      return ids;
    })();
  }

  /** Le sweep en cours d'exécution, s'il y en a un. */
  running(): Sweep | null {
    const row = this.db.query<Row, []>("SELECT * FROM sweeps WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
    return row ? this.toSweep(row) : null;
  }

  /** Au démarrage à froid : un sweep resté « running » devient « interrupted » (bouton Reprendre). */
  stopOrphans(): number {
    return this.db.run("UPDATE sweeps SET status = 'interrupted' WHERE status = 'running'").changes;
  }
}
