import { z } from "zod";
import {
  type BenchKind,
  type BenchParams,
  BenchParamsSchema,
  type BenchRun,
  benchSpecBase,
  CACHE_TYPES,
  FIELD_ORDER,
  FLASH_ATTN,
  SPLIT_MODES,
  serverArgs,
  serverArgsField,
} from "./bench";
import { NOISE, PRESET_IDS, type PresetId, presetOf } from "./tuning";

const values = <T extends z.ZodType>(t: T) => z.array(t).min(1, "au moins une valeur").optional();
const p = BenchParamsSchema.shape;
const inner = <T extends z.ZodType>(s: z.ZodOptional<T>): T => s.unwrap();

/** Pour chaque flag, les valeurs à essayer ; clé absente = la valeur de la base. */
export const SweepSpaceSchema = z.strictObject({
  ngl: values(inner(p.ngl)),
  ot: values(inner(p.ot)),
  ncmoe: values(inner(p.ncmoe)),
  dev: values(inner(p.dev)),
  ts: values(inner(p.ts)),
  sm: values(z.enum(SPLIT_MODES)),
  fa: values(z.enum(FLASH_ATTN)),
  ctk: values(z.enum(CACHE_TYPES)),
  ctv: values(z.enum(CACHE_TYPES)),
  t: values(inner(p.t)),
  b: values(inner(p.b)),
  ub: values(inner(p.ub)),
});
export type SweepSpace = z.infer<typeof SweepSpaceSchema>;

export const SweepSpecSchema = z.strictObject({
  name: z.string({ error: "obligatoire" }).trim().min(1, "obligatoire").max(80, "80 caractères au plus"),
  ...benchSpecBase,
  preset: z.enum(PRESET_IDS, { error: "préréglage inconnu" }),
  base: BenchParamsSchema.default({}),
  space: SweepSpaceSchema.default({}),
  serverArgs: serverArgsField,
  includeUnfit: z.boolean().default(false),
});
export type SweepSpec = z.infer<typeof SweepSpecSchema>;
export type SweepSpecInput = z.input<typeof SweepSpecSchema>;

export type SweepStatus = "running" | "done" | "cancelled" | "interrupted";

export interface Sweep {
  id: number;
  name: string;
  status: SweepStatus;
  spec: SweepSpec;
  bestRunId: number | null;
  /** Résumé du meilleur run (historique des sweeps sans charger leurs runs). */
  best: { label: string | null; kind: BenchKind; ppTps: number | null; tgTps: number | null } | null;
  counts: {
    total: number;
    queued: number;
    running: number;
    ok: number;
    failed: number;
    cancelled: number;
    interrupted: number;
  };
  createdAt: number;
  finishedAt: number | null;
}

export interface SweepLive {
  sweepId: number;
  runId: number | null;
  /** 1-based. */
  index: number;
  total: number;
  stage: "explore" | "validate";
}

/**
 * Produit cartésien de l'espace sur la base, dans l'ordre des champs. `-ts` ne s'applique qu'aux combinaisons dont `-dev` a
 * autant de devices (les autres n'en ont pas) ; un seul device → pas de `-ts`. Doublons retirés ; espace vide → [base].
 */
export function expandSpace(base: BenchParams, space: SweepSpace): { items: BenchParams[]; droppedTs: number } {
  let combos: BenchParams[] = [{ ...base }];
  for (const key of FIELD_ORDER) {
    const vals = space[key] as unknown[] | undefined;
    if (!vals) continue;
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [key]: v }) as BenchParams));
  }
  let droppedTs = 0;
  const seen = new Set<string>();
  const items: BenchParams[] = [];
  for (const c of combos) {
    const out = { ...c };
    if (out.ts) {
      const n = out.dev?.length;
      if (n === undefined || n <= 1 || n !== out.ts.length) {
        if (space.ts) droppedTs++;
        delete out.ts;
      }
    }
    const key = JSON.stringify(FIELD_ORDER.map((k) => out[k] ?? null));
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(out);
  }
  return { items, droppedTs };
}

/** Les seules dimensions de l'espace, en flags llama-server : « -ngl all · -ncmoe 8 · -dev CUDA0,Vulkan3 ». */
export function itemLabel(params: BenchParams, space: SweepSpace): string {
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    if (!space[key]) continue;
    const args = serverArgs({ [key]: params[key] } as BenchParams);
    parts.push(args.length ? args.join(" ") : `-${key} défaut`);
  }
  return parts.length ? parts.join(" · ") : "base";
}

/** Score du préréglage pour un run réussi ; null sinon. */
/** Contexte d'un sweep : le -c des autres flags serveur, sinon le minimum du préréglage. */
export function sweepCtx(spec: Pick<SweepSpec, "serverArgs" | "preset">): number {
  const args = spec.serverArgs;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = a === "-c" || a === "--ctx-size" ? args[i + 1] : a.startsWith("--ctx-size=") ? a.slice(11) : undefined;
    if (v !== undefined && /^\d+$/.test(v) && Number(v) > 0) return Number(v);
  }
  return presetOf(spec.preset).ctxMin;
}

export function scoreOf(preset: PresetId, run: Pick<BenchRun, "status" | "pp" | "tg">, ctx: number): number | null {
  if (run.status !== "ok" || !run.pp || !run.tg) return null;
  return presetOf(preset).score({ ppTps: run.pp.tps, tgTps: run.tg.tps, ctx });
}

export interface Ranked {
  run: BenchRun;
  score: number | null;
  rank: number | null;
  /** L'écart avec le meilleur est sous le bruit de mesure (le meilleur aussi, s'il a un ex æquo). */
  tie: boolean;
}

/** Runs réussis par score décroissant, puis les autres dans l'ordre d'origine. */
export function rankRuns(runs: BenchRun[], preset: PresetId, ctx: number): Ranked[] {
  const scored = runs.map((run) => ({ run, score: scoreOf(preset, run, ctx) }));
  const ok = scored
    .filter((s): s is { run: BenchRun; score: number } => s.score !== null)
    .sort((a, b) => b.score - a.score);
  const rest = scored.filter((s) => s.score === null);
  const best = ok[0];
  let band = 0;
  if (best?.run.pp && best.run.tg) {
    const low = presetOf(preset).score({
      ppTps: best.run.pp.tps * (1 - NOISE.pp),
      tgTps: best.run.tg.tps * (1 - NOISE.tg),
      ctx,
    });
    band = best.score - low;
  }
  const ranked: Ranked[] = ok.map((s, i) => ({ ...s, rank: i + 1, tie: i > 0 && best!.score - s.score <= band }));
  if (ranked.length > 1 && ranked.slice(1).some((r) => r.tie)) ranked[0]!.tie = true;
  return [...ranked, ...rest.map((s) => ({ ...s, rank: null, tie: false }))];
}

const LOAD_BYTES_PER_SEC = 1.5 * 1024 ** 3;

/** Durée grossière : un chargement par élément plus ~10 s par répétition. */
export function estimatedSweepSeconds(items: number, fileBytes: number, r: number): number {
  return Math.round(items * (fileBytes / LOAD_BYTES_PER_SEC + 10 * r));
}
