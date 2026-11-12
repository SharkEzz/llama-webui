/**
 * Run by `pnpm pack` (npm's `prepack`) from the package's root: refuses to pack without a build, which would write a
 * package that installs fine and has no `llama-webui` command. It does not build: release.yml and the tarball smoke
 * have already built, and a second `vite build` would double their time.
 */
import { statSync } from 'node:fs';

const FILES = ['dist/server/main.js', 'dist/server/nvml-worker.js', 'dist/web/index.html'];

const missing = FILES.filter((file) => !statSync(file, { throwIfNoEntry: false })?.isFile());
if (missing.length > 0) {
  console.error(`prepack: ${missing.join(', ')} missing: run pnpm build before packing`);
  process.exit(1);
}
