import type { Database } from "bun:sqlite";
import { type Profile, type ProfileInput, ProfileInputSchema, type ProfileSource } from "@llama-webui/shared";
import { HttpError, notFound } from "../http";

interface Row {
  id: number;
  name: string;
  model_path: string;
  mmproj_path: string | null;
  cwd: string | null;
  host: string | null;
  port: number | null;
  args_json: string;
  env_json: string;
  source: ProfileSource;
  created_at: number;
  updated_at: number;
}

function fromRow(r: Row): Profile {
  const p: Profile = {
    id: r.id,
    name: r.name,
    model: r.model_path,
    args: JSON.parse(r.args_json),
    env: JSON.parse(r.env_json),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.mmproj_path !== null) p.mmproj = r.mmproj_path;
  if (r.cwd !== null) p.cwd = r.cwd;
  if (r.host !== null) p.host = r.host;
  if (r.port !== null) p.port = r.port;
  return p;
}

/** Le profil au format llama-tui (sans id, source ni dates). */
export function toInput(p: Profile): ProfileInput {
  const { id: _id, source: _s, createdAt: _c, updatedAt: _u, ...input } = p;
  return input;
}

const conflict = (name: string) => new HttpError(409, `Un profil « ${name} » existe déjà`);

export class ProfilesRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Profile[] {
    return this.db.query<Row, []>("SELECT * FROM profiles ORDER BY name COLLATE NOCASE").all().map(fromRow);
  }

  get(id: number): Profile | null {
    const r = this.db.query<Row, [number]>("SELECT * FROM profiles WHERE id = ?").get(id);
    return r ? fromRow(r) : null;
  }

  private idOfName(name: string): number | null {
    return this.db.query<{ id: number }, [string]>("SELECT id FROM profiles WHERE name = ?").get(name)?.id ?? null;
  }

  private values(p: ProfileInput) {
    return [
      p.name,
      p.model,
      p.mmproj ?? null,
      p.cwd ?? null,
      p.host ?? null,
      p.port ?? null,
      JSON.stringify(p.args),
      JSON.stringify(p.env),
    ] as const;
  }

  /** Valide (ZodError si invalide) ; 409 si le nom est pris. */
  create(input: unknown, source: ProfileSource = "ui"): Profile {
    const p = ProfileInputSchema.parse(input);
    if (this.idOfName(p.name) !== null) throw conflict(p.name);
    const t = this.now();
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO profiles(name, model_path, mmproj_path, cwd, host, port, args_json, env_json, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...this.values(p), source, t, t);
    return this.get(Number(lastInsertRowid))!;
  }

  update(id: number, input: unknown): Profile {
    if (!this.get(id)) throw notFound("Profil");
    const p = ProfileInputSchema.parse(input);
    const other = this.idOfName(p.name);
    if (other !== null && other !== id) throw conflict(p.name);
    this.db
      .query(
        `UPDATE profiles SET name = ?, model_path = ?, mmproj_path = ?, cwd = ?, host = ?, port = ?, args_json = ?, env_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(...this.values(p), this.now(), id);
    return this.get(id)!;
  }

  remove(id: number): void {
    if (!this.get(id)) throw notFound("Profil");
    this.db.query("DELETE FROM profiles WHERE id = ?").run(id);
  }

  /** Copie nommée « <nom> (copie) », puis « (copie 2) »… */
  duplicate(id: number): Profile {
    const src = this.get(id);
    if (!src) throw notFound("Profil");
    let name = `${src.name} (copie)`;
    for (let n = 2; this.idOfName(name) !== null; n++) name = `${src.name} (copie ${n})`;
    return this.create({ ...toInput(src), name }, src.source === "llama-tui" ? "import" : src.source);
  }

  /** N'écrase jamais : un nom déjà en base est ignoré. */
  importMany(
    inputs: ProfileInput[],
    source: ProfileSource,
  ): { imported: Profile[]; skipped: { name: string; reason: string }[] } {
    const imported: Profile[] = [];
    const skipped: { name: string; reason: string }[] = [];
    this.db.transaction(() => {
      for (const input of inputs) {
        if (this.idOfName(input.name) !== null) skipped.push({ name: input.name, reason: "existe déjà" });
        else imported.push(this.create(input, source));
      }
    })();
    return { imported, skipped };
  }

  count(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM profiles").get()!.n;
  }
}
