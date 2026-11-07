import { z } from "zod";

/** Flags que llama-webui passe lui-même ; un profil ne peut pas les mettre dans `args`. */
export const RESERVED_FLAGS = [
  "--host",
  "--port",
  "--metrics",
  "--slots",
  "--props",
  "-m",
  "--model",
  "-mm",
  "--mmproj",
] as const;

/** Le flag réservé que passe `arg` (`--host=…` compte comme `--host`), s'il en passe un. */
export function reservedFlag(arg: string): string | undefined {
  const flag = arg.split("=")[0]!;
  return (RESERVED_FLAGS as readonly string[]).includes(flag) ? flag : undefined;
}

export const reservedFlagMessage = (flag: string) => `${flag} est géré par llama-webui (utilisez les champs du profil)`;

const required = () => z.string({ error: "obligatoire" }).min(1, "ne peut pas être vide");
const integer = () => z.number({ error: "nombre attendu" }).int({ error: "nombre entier attendu" });
const port = integer().min(1, "port entre 1 et 65535").max(65535, "port entre 1 et 65535");

/** Profil tel que llama-tui l'écrit dans sa config (format d'import/export). */
export const ProfileInputSchema = z
  .strictObject({
    name: required(),
    model: required(),
    mmproj: z.string().optional(),
    cwd: z.string().optional(),
    host: z.string().optional(),
    port: port.optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((p, ctx) => {
    p.args.forEach((arg, j) => {
      const flag = reservedFlag(arg);
      if (flag) ctx.addIssue({ code: "custom", path: ["args", j], message: reservedFlagMessage(flag) });
    });
  });

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export type ProfileSource = "ui" | "import" | "llama-tui";

export type Profile = ProfileInput & { id: number; source: ProfileSource; createdAt: number; updatedAt: number };

export interface ProfileImport {
  profiles: ProfileInput[];
  rejected: { name: string; reason: string }[];
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]!;
  return `${issue.message}${issue.path.length > 0 ? ` (${issue.path.join(".")})` : ""}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Lit un JSON d'import : config llama-tui entière (`{ profiles: [...] }`, autres clés ignorées), tableau de profils
 * ou profil seul. Chaque profil est validé isolément : les valides sont gardés, les autres expliqués.
 */
export function parseProfileImport(raw: unknown): ProfileImport {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (isObject(raw) && Array.isArray(raw.profiles)) items = raw.profiles;
  else if (isObject(raw) && ("name" in raw || "model" in raw)) items = [raw];
  else return { profiles: [], rejected: [{ name: "(fichier)", reason: "aucun profil trouvé dans ce JSON" }] };

  const result: ProfileImport = { profiles: [], rejected: [] };
  const seen = new Set<string>();
  for (const item of items) {
    const name = isObject(item) && typeof item.name === "string" && item.name ? item.name : "(sans nom)";
    const parsed = ProfileInputSchema.safeParse(item);
    if (!parsed.success) result.rejected.push({ name, reason: firstIssue(parsed.error) });
    else if (seen.has(parsed.data.name)) result.rejected.push({ name, reason: "nom en double dans le fichier" });
    else {
      seen.add(parsed.data.name);
      result.profiles.push(parsed.data);
    }
  }
  return result;
}
