import type { Database } from "bun:sqlite";
import type { BenchHardware, BenchKind, BenchRun, BenchSpec, BenchStatus, Measure } from "@llama-webui/shared";

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
  created_at: number;
}

interface Stats {
  pp: Measure | null;
  tg: Measure | null;
  draftAcceptPct: number | null;
}

const toRun = (r: Row): BenchRun => {
  const stats: Stats = r.stats_json ? JSON.parse(r.stats_json) : { pp: null, tg: null, draftAcceptPct: null };
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    spec: JSON.parse(r.args_json),
    command: r.command,
    hardware: JSON.parse(r.hardware_json),
    pp: stats.pp,
    tg: stats.tg,
    draftAcceptPct: stats.draftAcceptPct,
    vramPeak: JSON.parse(r.vram_mib_json),
    error: r.error,
    logExcerpt: r.log_excerpt,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
};

export type BenchFinish = Partial<Pick<BenchRun, "status" | "pp" | "tg" | "draftAcceptPct" | "vramPeak" | "error" | "logExcerpt" | "durationMs">>;

const ENDED_BADLY = "('failed', 'cancelled', 'interrupted')";

/** Les runs de benchmark (`bench_runs`). */
export class BenchRunsRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(spec: BenchSpec, command: string, hardware: BenchHardware): BenchRun {
    const row = this.db
      .query<Row, (string | number | null)[]>(
        `INSERT INTO bench_runs(kind, status, model_path, profile_id, args_json, command, hardware_json, vram_mib_json, created_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, '[]', ?) RETURNING *`,
      )
      .get(spec.kind, spec.modelPath, spec.profileId, JSON.stringify(spec), command, JSON.stringify(hardware), this.now())!;
    return toRun(row);
  }

  finish(id: number, patch: BenchFinish): BenchRun {
    const cur = this.get(id);
    if (!cur) throw new Error(`run ${id} introuvable`);
    const next = { ...cur, ...patch };
    const stats: Stats = { pp: next.pp, tg: next.tg, draftAcceptPct: next.draftAcceptPct };
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

  list(f: { kind?: BenchKind; modelPath?: string; status?: BenchStatus } = {}): BenchRun[] {
    const where: string[] = [];
    const args: string[] = [];
    if (f.kind) (where.push("kind = ?"), args.push(f.kind));
    if (f.modelPath) (where.push("model_path = ?"), args.push(f.modelPath));
    if (f.status) (where.push("status = ?"), args.push(f.status));
    const sql = `SELECT * FROM bench_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`;
    return this.db.query<Row, string[]>(sql).all(...args).map(toRun);
  }

  get(id: number): BenchRun | null {
    const row = this.db.query<Row, [number]>("SELECT * FROM bench_runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  delete(id: number): boolean {
    return this.db.run("DELETE FROM bench_runs WHERE id = ?", [id]).changes > 0;
  }

  /** Supprime les runs en échec, annulés ou interrompus. */
  deleteFailed(): number {
    return this.db.run(`DELETE FROM bench_runs WHERE status IN ${ENDED_BADLY}`).changes;
  }

  /** Au démarrage : un run resté « running » (Bun arrêté brutalement) devient « interrupted ». */
  stopOrphans(): number {
    return this.db.run("UPDATE bench_runs SET status = 'interrupted', error = COALESCE(error, 'interrompu (arrêt de llama-webui)') WHERE status = 'running'")
      .changes;
  }
}
