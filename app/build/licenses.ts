/**
 * `THIRD-PARTY-LICENSES.md` next to the server bundle: the license of every npm package bundled into it, from the
 * modules Rolldown reports (`build/server.ts`).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Package {
  name: string;
  version: string;
  license: string;
  text: string | null;
}

/** `/x/node_modules/.pnpm/a@1/node_modules/@s/b/dist/i.js` → `/x/…/node_modules/@s/b`; null outside node_modules. */
export function packageRoot(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = id.slice(at + '/node_modules/'.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  return rest.length > depth ? id.slice(0, at + '/node_modules/'.length) + rest.slice(0, depth).join('/') : null;
}

function read(root: string): Package {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  const file = readdirSync(root).find((f) => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(f));
  return {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'unknown',
    text: file ? readFileSync(join(root, file), 'utf8').trim() : null,
  };
}

export function render(packages: Package[]): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = sorted.map(
    (p) => `## ${p.name} - ${p.version} (${p.license})\n\n${p.text ?? `No license file; package.json: ${p.license}.`}`,
  );
  return `# Licenses\n\nThe server bundles these packages, under these licenses:\n\n${sections.join('\n\n')}\n`;
}

/** Writes `file`: the license of every npm package among `moduleIds` (the modules Rolldown bundled). */
export function writeLicenses(moduleIds: Iterable<string>, file: string): void {
  // One entry per package and version: two copies of the same version are one license.
  const seen = new Map<string, Package>();
  for (const id of moduleIds) {
    const root = packageRoot(id.replace(/^\0/, '').split('?')[0] as string);
    if (!root) continue;
    const p = read(root);
    seen.set(`${p.name}@${p.version}`, p);
  }
  writeFileSync(file, render([...seen.values()]));
}
