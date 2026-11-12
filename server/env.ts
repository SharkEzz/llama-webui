/**
 * Loads `.env` (in the working directory by default) into `process.env`, under the variables already set, as Bun did
 * for `bun run dev`/`start`. No file, nothing to do. Called by the entry points (`server/dev.ts`, `server/main.ts`).
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
