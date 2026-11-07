import { z } from "zod";
import { reservedFlag, reservedFlagMessage } from "./profile";
import type { FitVerdict } from "./tuning";

export const CACHE_TYPES = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"] as const;
export type CacheType = (typeof CACHE_TYPES)[number];
export const SPLIT_MODES = ["none", "layer", "row", "tensor"] as const;
export const FLASH_ATTN = ["on", "off", "auto"] as const;

const int = (min: number, max = 1_000_000) =>
  z
    .number({ error: "nombre attendu" })
    .int({ error: "nombre entier attendu" })
    .min(min, `au moins ${min}`)
    .max(max, `au plus ${max}`);

/** Flags de la spec, sous une forme commune aux deux outils. Clé absente = défaut de l'outil. */
export const BenchParamsSchema = z.strictObject({
  ngl: z.union([int(0, 9999), z.literal("all"), z.literal("auto")], { error: "nombre, « all » ou « auto »" }).optional(),
  ot: z.array(z.string().regex(/^[^=,;]+=[^=,;]+$/, "motif=buffer attendu (ex. exps=CPU)")).optional(),
  ncmoe: int(0, 9999).optional(),
  dev: z.array(z.string().regex(/^[A-Za-z]+\d*$/, "nom de device attendu (ex. CUDA0)")).optional(),
  ts: z.array(z.number({ error: "nombre attendu" }).min(0, "proportion positive attendue")).optional(),
  sm: z.enum(SPLIT_MODES, { error: "none, layer, row ou tensor" }).optional(),
  fa: z.enum(FLASH_ATTN, { error: "on, off ou auto" }).optional(),
  ctk: z.enum(CACHE_TYPES, { error: "type de cache inconnu" }).optional(),
  ctv: z.enum(CACHE_TYPES, { error: "type de cache inconnu" }).optional(),
  t: int(1, 1024).optional(),
  b: int(1).optional(),
  ub: int(1).optional(),
});
export type BenchParams = z.infer<typeof BenchParamsSchema>;
type Key = keyof BenchParams;

/** Ordre fixe des champs, avec leur flag court et leurs formes longues côté llama-server. */
const FIELDS: { key: Key; short: string; long: string[] }[] = [
  { key: "ngl", short: "-ngl", long: ["--gpu-layers", "--n-gpu-layers"] },
  { key: "ot", short: "-ot", long: ["--override-tensor"] },
  { key: "ncmoe", short: "-ncmoe", long: ["--n-cpu-moe"] },
  { key: "dev", short: "-dev", long: ["--device"] },
  { key: "ts", short: "-ts", long: ["--tensor-split"] },
  { key: "sm", short: "-sm", long: ["--split-mode"] },
  { key: "fa", short: "-fa", long: ["--flash-attn"] },
  { key: "ctk", short: "-ctk", long: ["--cache-type-k"] },
  { key: "ctv", short: "-ctv", long: ["--cache-type-v"] },
  { key: "t", short: "-t", long: ["--threads"] },
  { key: "b", short: "-b", long: ["--batch-size"] },
  { key: "ub", short: "-ub", long: ["--ubatch-size"] },
];
/** Ordre fixe des champs (traduction, produit cartésien d'un sweep, étiquettes). */
export const FIELD_ORDER: readonly Key[] = FIELDS.map((f) => f.key);
const BY_FLAG = new Map(FIELDS.flatMap((f) => [f.short, ...f.long].map((flag) => [flag, f] as const)));

export type BenchKind = "bench" | "server";
/** « queued » : élément d'un sweep en attente. */
export type BenchStatus = "queued" | "running" | "ok" | "failed" | "cancelled" | "interrupted";

/** « Autres flags serveur » : refuse les flags réservés et ceux couverts par un champ, à l'index fautif. */
export const serverArgsField = z
  .array(z.string())
  .default([])
  .superRefine((args, ctx) => {
    args.forEach((arg, i) => {
      const flag = arg.split("=")[0]!;
      const reserved = reservedFlag(arg);
      if (reserved) ctx.addIssue({ code: "custom", path: [i], message: reservedFlagMessage(reserved) });
      else {
        const field = BY_FLAG.get(flag);
        if (field) ctx.addIssue({ code: "custom", path: [i], message: `${flag} : utilisez le champ ${field.short}` });
      }
    });
  });

/** Champs communs à un run et à un sweep. */
export const benchSpecBase = {
  modelPath: z
    .string({ error: "obligatoire" })
    .refine((p) => p.startsWith("/"), "chemin absolu attendu")
    .refine((p) => p.endsWith(".gguf"), "fichier .gguf attendu"),
  mmprojPath: z.string().nullable().default(null),
  profileId: z.number().int().nullable().default(null),
  p: int(1, 32_768).default(512),
  n: int(1, 4096).default(128),
  r: int(1, 20).default(3),
};

export const BenchSpecSchema = z.strictObject({
  kind: z.enum(["bench", "server"], { error: "« bench » ou « server »" }),
  ...benchSpecBase,
  params: BenchParamsSchema.default({}),
  serverArgs: serverArgsField,
});
export type BenchSpec = z.infer<typeof BenchSpecSchema>;
export type BenchSpecInput = z.input<typeof BenchSpecSchema>;

export interface Measure {
  tps: number;
  stddev: number;
  tokens: number;
}

export interface BenchHardware {
  cpu: string;
  gpus: { name: string; busId: string; vramTotalBytes: number }[];
  build: string | null;
}

export interface BenchRun {
  id: number;
  kind: BenchKind;
  status: BenchStatus;
  spec: BenchSpec;
  command: string;
  hardware: BenchHardware;
  pp: Measure | null;
  tg: Measure | null;
  draftAcceptPct: number | null;
  vramPeak: { key: string; name: string; mib: number }[];
  error: string | null;
  logExcerpt: string;
  durationMs: number | null;
  /** Débit de lecture du disque du modèle au plus haut pendant le run (octets/s), si mesuré. */
  diskReadPeakBps: number | null;
  sweepId: number | null;
  /** Étiquette de l'élément dans son sweep (« -ncmoe 8 · -dev CUDA0,CUDA1 »). */
  sweepLabel: string | null;
  /** Verdict de l'estimateur au moment du plan. */
  fit: FitVerdict | null;
  createdAt: number;
}

export type BenchPhase = "stopping-server" | "loading" | "warmup" | "prompt" | "generation" | "measure" | "restarting-server";

export interface BenchLive {
  runId: number;
  kind: BenchKind;
  phase: BenchPhase;
  step: { index: number; total: number } | null;
  startedAt: number;
  /** Les 20 dernières lignes de l'outil. */
  lines: string[];
}

export interface BenchDevice {
  id: string;
  name: string;
  totalMib: number;
  freeMib: number;
  /** Lettres de l'id : "CUDA", "Vulkan", "BLAS"… */
  backend: string;
}

/** Valeur lue pour un champ, ou undefined si elle n'est pas lisible (le flag reste alors dans `rest`). */
function readValue(key: Key, raw: string): BenchParams[Key] | undefined {
  const num = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined);
  const intOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);
  const list = (s: string) => s.split(",").filter((x) => x !== "");
  switch (key) {
    case "ngl":
      return raw === "all" || raw === "auto" ? raw : intOf(raw);
    case "ot":
      return list(raw);
    case "dev":
      return list(raw);
    case "ts": {
      const parts = list(raw).map(num);
      return parts.length > 0 && parts.every((x) => x !== undefined) ? (parts as number[]) : undefined;
    }
    case "sm":
      return (SPLIT_MODES as readonly string[]).includes(raw) ? (raw as BenchParams["sm"]) : undefined;
    case "fa":
      return (FLASH_ATTN as readonly string[]).includes(raw) ? (raw as BenchParams["fa"]) : undefined;
    case "ctk":
    case "ctv":
      return (CACHE_TYPES as readonly string[]).includes(raw) ? (raw as BenchParams["ctk"]) : undefined;
    default:
      return intOf(raw);
  }
}

/** Décompose les args d'un profil llama-server : les flags couverts par un champ, et le reste dans l'ordre d'origine. */
export function paramsFromServerArgs(args: string[]): { params: BenchParams; rest: string[] } {
  const params: BenchParams = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("-") && eq > 0 ? arg.slice(0, eq) : arg;
    const field = BY_FLAG.get(flag);
    if (!field) {
      rest.push(arg);
      continue;
    }
    let raw: string | undefined;
    const taken: string[] = [arg];
    if (eq > 0 && flag !== arg) raw = arg.slice(eq + 1);
    else if (field.key === "fa") {
      // -fa sans valeur (ancienne forme) = on.
      const next = args[i + 1];
      if (next !== undefined && (FLASH_ATTN as readonly string[]).includes(next)) {
        raw = next;
        taken.push(next);
        i++;
      } else raw = "on";
    } else if (i + 1 < args.length) {
      raw = args[++i]!;
      taken.push(raw);
    }
    const value = raw === undefined ? undefined : readValue(field.key, raw);
    if (value === undefined) {
      rest.push(...taken);
      continue;
    }
    if (field.key === "ot") params.ot = [...(params.ot ?? []), ...(value as string[])];
    else (params as Record<string, unknown>)[field.key] = value;
  }
  return { params, rest };
}

function toArgs(p: BenchParams, tool: BenchKind): string[] {
  const out: string[] = [];
  const sep = tool === "bench" ? "/" : ",";
  for (const { key, short } of FIELDS) {
    const v = p[key];
    if (v === undefined) continue;
    if (key === "ngl" && v === "auto") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    let s: string;
    if (key === "ngl") s = v === "all" ? (tool === "bench" ? "999" : "all") : String(v);
    else if (key === "ot") s = (v as string[]).join(tool === "bench" ? ";" : ",");
    else if (Array.isArray(v)) s = v.map(String).join(sep);
    else s = String(v);
    out.push(short, s);
  }
  return out;
}

/** Les champs en flags llama-server (`,` entre les valeurs). */
export const serverArgs = (p: BenchParams): string[] => toArgs(p, "server");
/** Les champs en flags llama-bench (`/` pour -dev et -ts, `;` pour -ot). */
export const benchArgs = (p: BenchParams): string[] => toArgs(p, "bench");

const IGNORED: { test: (flag: string) => boolean; why: string }[] = [
  { test: (f) => f === "-c" || f === "--ctx-size", why: "contexte non réservé" },
  {
    test: (f) => f === "--spec-type" || f === "-md" || f === "--model-draft" || f.startsWith("--draft") || f === "-ngld" || f === "-devd",
    why: "décodage spéculatif non mesuré",
  },
  { test: (f) => f === "-cmoe" || f === "--cpu-moe", why: "utilisez -ncmoe" },
  { test: (f) => f === "-np" || f === "--parallel", why: "slots parallèles" },
];

/** Flags d'un profil qui changent vitesse ou mémoire et que llama-bench ne reproduit pas. */
export function ignoredByBench(rest: string[]): { flag: string; why: string }[] {
  const out: { flag: string; why: string }[] = [];
  for (const arg of rest) {
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=")[0]!;
    const hit = IGNORED.find((i) => i.test(flag));
    if (hit) out.push({ flag, why: hit.why });
  }
  return out;
}
