import { spawn } from 'node:child_process';
import { definePlugin } from 'nitro';
import { log } from '../log.ts';

declare const LLAMA_WEBUI_VERSION: string | undefined;

const g = globalThis as { __probeBoots?: number };

export default definePlugin((nitroApp) => {
  const child = spawn('sleep', ['10000'], { stdio: 'ignore' });
  const hot = (import.meta as { hot?: { dispose(cb: () => unknown): void } }).hot;
  g.__probeBoots = (g.__probeBoots ?? 0) + 1;
  log(
    `plugin start child=${child.pid} hot=${typeof hot} boots=${g.__probeBoots} argv=${process.argv.length} version=${typeof LLAMA_WEBUI_VERSION === 'string' ? LLAMA_WEBUI_VERSION : 'undefined'}`,
  );
  hot?.dispose(() => {
    log(`hot.dispose child=${child.pid}`);
    child.kill('SIGTERM');
  });
  process.on('exit', (code) => log(`process exit code=${code} child=${child.pid}`));
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => log(`signal ${s}`));
  nitroApp.hooks.hook('close', async () => {
    log(`close hook start child=${child.pid}`);
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_CLOSE_MS ?? 1500)));
    child.kill('SIGTERM');
    log(`close hook end child=${child.pid}`);
  });
});
