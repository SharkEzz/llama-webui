import { z } from "zod";

export const SettingsSchema = z.object({
  binary: z.string().min(1, "Obligatoire").default("llama-server"),
  host: z.string().min(1, "Obligatoire").default("0.0.0.0"),
  port: z
    .number({ error: "Nombre attendu" })
    .int("Nombre entier attendu")
    .min(1, "Port entre 1 et 65535")
    .max(65535, "Port entre 1 et 65535")
    .default(8080),
  modelsDir: z.string().min(1, "Obligatoire").default("~/Modèles"),
  pollIntervalMs: z.number().int().min(250, "Au moins 250 ms").default(1000),
  historySeconds: z.number().int().min(30, "Entre 30 et 1800 s").max(1800, "Entre 30 et 1800 s").default(300),
  hiddenGpus: z.array(z.string()).default(["0000:0d:00.0"]),
  defaultProfileId: z.number().int().nullable().default(null),
  llamaTuiImportDismissed: z.boolean().default(false),
  collectors: z
    .object({ nvml: z.boolean().default(true), system: z.boolean().default(true), disk: z.boolean().default(true) })
    .default({ nvml: true, system: true, disk: true }),
  theme: z.enum(["system", "light", "dark"]).default("system"),
});

export type ThemeMode = Settings["theme"];

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
