#!/usr/bin/env node
// Production launcher, built to `.output/llama-webui.mjs` (`compiled` hook of `vite.config.ts`): the CLI as before
// (`--help`, `--host`, `--port`, `--data-dir`, `--env-override`), then Nitro's server. Nitro reads its address from
// `NITRO_HOST`/`NITRO_PORT`, the runtime its options from `LLAMA_WEBUI_*` (`server/lib/boot.ts`): both are set from the
// parsed options, which the flags, the environment and `.env` gave in that order.
import { cliOptionsOrExit } from '../server/lib/cli.ts';
import { loadDotEnv, overrideFlag } from '../server/lib/env.ts';

loadDotEnv('.env', { override: overrideFlag() });
const options = cliOptionsOrExit();
process.env.NITRO_HOST = process.env.LLAMA_WEBUI_HOST = options.host;
process.env.NITRO_PORT = process.env.LLAMA_WEBUI_PORT = String(options.port);
if (options.dataDir) process.env.LLAMA_WEBUI_DATA_DIR = options.dataDir;
process.env.NODE_ENV ??= 'production';
// Next to this file once built; a runtime URL, so the bundler leaves it alone.
const server = new URL('./server/index.mjs', import.meta.url);
await import(server.href);
