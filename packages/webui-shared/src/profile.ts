import { z } from 'zod';

/** Flags llama-webui passes itself; a profile cannot put them in `args`. */
export const RESERVED_FLAGS = [
  '--host',
  '--port',
  '--metrics',
  '--slots',
  '--props',
  '-m',
  '--model',
  '-mm',
  '--mmproj',
] as const;

/** The reserved flag `arg` passes (`--host=…` counts as `--host`), if any. */
export function reservedFlag(arg: string): string | undefined {
  const flag = arg.split('=')[0]!;
  return (RESERVED_FLAGS as readonly string[]).includes(flag) ? flag : undefined;
}

export const reservedFlagMessage = (flag: string) => `${flag} is managed by llama-webui (use the profile fields)`;

const required = () => z.string({ error: 'required' }).min(1, 'cannot be empty');
const integer = () => z.number({ error: 'expected a number' }).int({ error: 'expected an integer' });
const port = integer().min(1, 'port between 1 and 65535').max(65535, 'port between 1 and 65535');

/** Profile as llama-tui writes it in its config (import/export format). */
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
      if (flag) ctx.addIssue({ code: 'custom', path: ['args', j], message: reservedFlagMessage(flag) });
    });
  });

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export type ProfileSource = 'ui' | 'import' | 'llama-tui';

export type Profile = ProfileInput & { id: number; source: ProfileSource; createdAt: number; updatedAt: number };

export interface ProfileImport {
  profiles: ProfileInput[];
  rejected: { name: string; reason: string }[];
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]!;
  return `${issue.message}${issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads an import JSON: a whole llama-tui config (`{ profiles: [...] }`, other keys ignored), an array of profiles or
 * a single profile. Each profile is validated on its own: valid ones are kept, the others explained.
 */
export function parseProfileImport(raw: unknown): ProfileImport {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (isObject(raw) && Array.isArray(raw.profiles)) items = raw.profiles;
  else if (isObject(raw) && ('name' in raw || 'model' in raw)) items = [raw];
  else return { profiles: [], rejected: [{ name: '(file)', reason: 'no profile found in this JSON' }] };

  const result: ProfileImport = { profiles: [], rejected: [] };
  const seen = new Set<string>();
  for (const item of items) {
    const name = isObject(item) && typeof item.name === 'string' && item.name ? item.name : '(unnamed)';
    const parsed = ProfileInputSchema.safeParse(item);
    if (!parsed.success) result.rejected.push({ name, reason: firstIssue(parsed.error) });
    else if (seen.has(parsed.data.name)) result.rejected.push({ name, reason: 'duplicate name in the file' });
    else {
      seen.add(parsed.data.name);
      result.profiles.push(parsed.data);
    }
  }
  return result;
}
