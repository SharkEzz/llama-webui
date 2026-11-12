import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Loads `.env` (in the working directory by default) into `process.env`. Its variables override those already set in
 * the environment. No file, nothing to do. Called by the entry points (`server/dev.ts`, `server/main.ts`).
 */
export function loadDotEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  Object.assign(process.env, parseEnv(text));
}
