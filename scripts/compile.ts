/**
 * Standalone executable:
 * `bun run compile [--target bun-linux-x64|bun-linux-arm64] [--outfile dist/llama-webui] [--version <name>]`.
 * One file holding the Bun runtime, the server and the UI (bundled and split per page at compile time, embedded):
 * always production, nothing to install. Without --target, builds for this machine.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { NVML_WORKER } from '../server/collectors/nvml/monitor';
import { WEB_BUILD_OPTIONS, webPlugins } from '../server/routes/web';

const ROOT = resolve(import.meta.dir, '..');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: 'string' }, outfile: { type: 'string' }, version: { type: 'string' } },
  strict: true,
  allowPositionals: false,
});

// llama-webui reads /proc and /sys: Linux only.
const target = values.target;
if (target !== undefined && !target.startsWith('bun-linux-')) {
  console.error(`compile: unsupported --target “${target}” (bun-linux-x64, bun-linux-arm64…)`);
  process.exit(2);
}
const outfile = values.outfile ?? `${ROOT}/dist/llama-webui`;

// Shown in the status bar (`server/version.ts`): the tag, else the short commit hash; `-dirty` with uncommitted changes.
const described = await Bun.$`git -C ${ROOT} describe --tags --always --dirty`.quiet().nothrow();
const version = values.version ?? (described.exitCode === 0 ? described.text().trim() : 'unknown');

const started = performance.now();
const result = await Bun.build({
  ...WEB_BUILD_OPTIONS,
  define: { ...WEB_BUILD_OPTIONS.define, LLAMA_WEBUI_VERSION: JSON.stringify(version) },
  entrypoints: [
    `${ROOT}/server/index.ts`,
    // Loaded with `new Worker(…)`: a worker has to be its own entrypoint to be embedded. Every entrypoint stays
    // under server/: the worker is then embedded at the path `workerUrl()` expects.
    `${ROOT}/server/${NVML_WORKER}`,
  ],
  // The UI is bundled here, from the HTML import; the binary never runs the startup build.
  plugins: await webPlugins(),
  external: ['bun-plugin-tailwind'],
  compile: {
    outfile,
    ...(target ? { target: target as Bun.Build.CompileTarget } : {}),
    // A bunfig.toml in the user's working directory must not change the binary's behaviour.
    autoloadBunfig: false,
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error('compile: failed');
  process.exit(1);
}
const size = Bun.file(outfile).size;
console.log(
  `compile: ${outfile} (${version}, ${(size / 2 ** 20).toFixed(1)} MiB, ${target ?? 'this machine'}) in ${Math.round(performance.now() - started)} ms`,
);
