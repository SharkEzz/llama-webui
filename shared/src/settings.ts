import { z } from "zod";

export const SettingsSchema = z.object({
  binary: z.string().min(1).default("llama-server"),
  host: z.string().min(1).default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(8080),
  modelsDir: z.string().min(1).default("~/Modèles"),
  pollIntervalMs: z.number().int().min(250).default(1000),
  historySeconds: z.number().int().min(30).max(1800).default(300),
  hiddenGpus: z.array(z.string()).default(["0000:0d:00.0"]),
  defaultProfileId: z.number().int().nullable().default(null),
  llamaTuiImportDismissed: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
