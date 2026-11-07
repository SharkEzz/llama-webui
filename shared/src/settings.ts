import { z } from 'zod';

export const SettingsSchema = z.object({
  binary: z.string().min(1, 'Required').default('llama-server'),
  host: z.string().min(1, 'Required').default('0.0.0.0'),
  port: z
    .number({ error: 'Expected a number' })
    .int('Expected an integer')
    .min(1, 'Port between 1 and 65535')
    .max(65535, 'Port between 1 and 65535')
    .default(8080),
  modelsDir: z.string().min(1, 'Required').default('~/models'),
  pollIntervalMs: z.number().int().min(250, 'At least 250 ms').default(1000),
  historySeconds: z.number().int().min(30, 'Between 30 and 1800 s').max(1800, 'Between 30 and 1800 s').default(300),
  hiddenGpus: z.array(z.string()).default(['0000:0d:00.0']),
  defaultProfileId: z.number().int().nullable().default(null),
  llamaTuiImportDismissed: z.boolean().default(false),
  collectors: z
    .object({ nvml: z.boolean().default(true), system: z.boolean().default(true), disk: z.boolean().default(true) })
    .default({ nvml: true, system: true, disk: true }),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

export type ThemeMode = Settings['theme'];

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
