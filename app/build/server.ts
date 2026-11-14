/**
 * The server half of `pnpm build`, run after `vite build` wrote the client to `.output/public`: bundles the Effect
 * server (`server/main.ts`) into `.output/server/index.mjs` and the launcher (`bin/llama-webui.ts`) into
 * `.output/llama-webui.mjs`, each one file that requires nothing but Node builtins, then writes
 * `.output/server/THIRD-PARTY-LICENSES.md` from the modules bundled into the server.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Plugin } from 'rolldown';
import { writeLicenses } from './licenses.ts';

const r = (p: string) => resolve(import.meta.dirname, '..', p);
const OUTPUT = r('.output');
const SERVER = join(OUTPUT, 'server');

/** Version shown by `/api/health` and the status bar: the tag, else the short hash, else package.json's version. */
function version(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: r('.'), encoding: 'utf8' }).trim();
  } catch {
    return (JSON.parse(readFileSync(r('package.json'), 'utf8')) as { version: string }).version;
  }
}

/**
 * `ws` (bundled with `@effect/platform-node`) tries two optional native addons and falls back to JavaScript when
 * `require` throws: they resolve to a module that throws.
 */
const OPTIONAL_ADDONS = new Set(['bufferutil', 'utf-8-validate']);
const optionalAddons: Plugin = {
  name: 'llama-webui:optional-addons',
  resolveId: (id) => (OPTIONAL_ADDONS.has(id) ? `\0optional-addon:${id}` : null),
  load: (id) =>
    id.startsWith('\0optional-addon:')
      ? `throw new Error(${JSON.stringify(`${id.slice('\0optional-addon:'.length)} is not bundled`)});`
      : null,
};

// Nothing of an earlier build (another server's chunks) stays next to the new bundle; `public/` is Vite's, just written.
for (const entry of readdirSync(OUTPUT))
  if (entry !== 'public') rmSync(join(OUTPUT, entry), { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });

const server = await build({
  input: r('server/main.ts'),
  platform: 'node',
  plugins: [optionalAddons],
  transform: { define: { LLAMA_WEBUI_VERSION: JSON.stringify(version()) } },
  output: { file: join(SERVER, 'index.mjs'), codeSplitting: false },
});

const launcher = join(OUTPUT, 'llama-webui.mjs');
await build({
  input: r('bin/llama-webui.ts'),
  platform: 'node',
  // The server bundle sits next to the launcher in `.output`.
  external: ['./server/index.mjs'],
  output: { file: launcher, codeSplitting: false },
});
chmodSync(launcher, 0o755);

writeLicenses(
  server.output.flatMap((out) => (out.type === 'chunk' ? out.moduleIds : [])),
  join(SERVER, 'THIRD-PARTY-LICENSES.md'),
);
