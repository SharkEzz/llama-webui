/**
 * `THIRD-PARTY-LICENSES.md` next to Nitro's server: the license of every npm package bundled into it. Vite's own
 * `build.license` does not reach Nitro's output (its asset is dropped), so a plugin on Nitro's environment collects
 * the bundled modules and the `compiled` hook writes the file.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

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

export function licenses(): { plugin: Plugin; write(serverDir: string): void } {
  const roots = new Set<string>();
  return {
    plugin: {
      name: 'llama-webui:licenses',
      applyToEnvironment: (env) => env.name === 'nitro',
      generateBundle(_options, bundle) {
        for (const out of Object.values(bundle))
          if (out.type === 'chunk')
            for (const id of out.moduleIds) {
              const root = packageRoot(id.replace(/^\0/, '').split('?')[0] as string);
              if (root) roots.add(root);
            }
      },
    },
    write(serverDir) {
      // One entry per package and version: two copies of the same version are one license.
      const seen = new Map<string, Package>();
      for (const root of roots) {
        const p = read(root);
        seen.set(`${p.name}@${p.version}`, p);
      }
      writeFileSync(join(serverDir, 'THIRD-PARTY-LICENSES.md'), render([...seen.values()]));
    },
  };
}
