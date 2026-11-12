import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Lets `.env` override the environment: `1` or `true`, set in the environment or in the file itself. */
export const ENV_OVERRIDE = 'LLAMA_WEBUI_ENV_OVERRIDE';

/** The `--env-override` flag, read from the arguments before they are parsed (the `.env` comes first). */
export const overrideFlag = (argv = process.argv.slice(2)) => argv.includes('--env-override');

const enabled = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

/**
 * Loads `.env` (in the working directory by default) into `process.env`. Its variables fill what the environment
 * lacks; with `override` (`--env-override`) or `LLAMA_WEBUI_ENV_OVERRIDE` on, they also replace those already set. No file, nothing to do. Called by
 * the entry points (`server/dev.ts`, `server/main.ts`).
 */
export function loadDotEnv(path = '.env', o: { override?: boolean } = {}): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const vars = parseEnv(text);
  const override = o.override || enabled(process.env[ENV_OVERRIDE] ?? vars[ENV_OVERRIDE]);
  for (const [key, value] of Object.entries(vars))
    if (override || process.env[key] === undefined) process.env[key] = value;
}
