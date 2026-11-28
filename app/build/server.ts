/**
 * The server half of `pnpm build`, run after `vite build` wrote the client to `.output/public`: bundles the Effect
 * server (`server/main.ts`) into `.output/server/index.mjs`, the NVML sampler (`server/collectors/nvml/worker.ts`)
 * into `.output/server/nvml-worker.mjs` and the launcher (`bin/llama-webui.ts`) into `.output/llama-webui.mjs`, each
 * one file that requires nothing but Node builtins, then writes
 * `.output/server/THIRD-PARTY-LICENSES.md` from the modules bundled into the server and the sampler, and the `.br` and
 * `.gz` of the client's hashed assets (`build/precompress.ts`).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Plugin } from 'rolldown';
import { writeLicenses } from './licenses.ts';
import { precompress } from './precompress.ts';

const r = (p: string) => resolve(import.meta.dirname, '..', p);
const OUTPUT = r('.output');
const SERVER = join(OUTPUT, 'server');

/** Version shown by `/api/health` and the status bar: the tag, else the short hash, else package.json's version. */
function version(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: r('.'), encoding: 'utf8' }).trim();
  } catch {
    const pkg: unknown = JSON.parse(readFileSync(r('package.json'), 'utf8'));
    return String(typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'version') : undefined);
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

// The NVML sampler, a program of its own: `workerPath` of `server/collectors/nvml/Nvml.ts` finds it next to `index.mjs`.
const sampler = await build({
  input: r('server/collectors/nvml/worker.ts'),
  platform: 'node',
  plugins: [optionalAddons],
  output: { file: join(SERVER, 'nvml-worker.mjs'), codeSplitting: false },
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
  [...server.output, ...sampler.output].flatMap((out) => (out.type === 'chunk' ? out.moduleIds : [])),
  join(SERVER, 'THIRD-PARTY-LICENSES.md'),
);

const assets = await precompress(join(OUTPUT, 'public', 'assets'));
const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
console.log(`precompressed ${assets.files} assets: ${kib(assets.bytes)} → ${kib(assets.br)} br, ${kib(assets.gz)} gz`);
