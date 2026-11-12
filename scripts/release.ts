/**
 * Versions of the repository's package.json files, kept equal to the release tag.
 * - `bun run release 0.2.0`: sets `version` in every package.json (commit it through a PR, then tag `v0.2.0` on master);
 * - `bun scripts/release.ts --check v0.2.0`: fails unless every package.json has that version (release workflow).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');

/** Every package.json carrying the version, relative to the root. */
export const PACKAGE_FILES = [
  'package.json',
  'server/package.json',
  'packages/webui-shared/package.json',
  'packages/llamacpp-js/package.json',
  'web/package.json',
  'site/package.json',
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `v0.2.0` or `0.2.0` → `0.2.0`; null when it is not a semantic version. */
export function parseVersion(raw: string): string | null {
  const v = raw.startsWith('v') ? raw.slice(1) : raw;
  return SEMVER.test(v) ? v : null;
}

/** The package.json text with `version` set, right after `name` when it was missing; the other keys keep their order. */
export function withVersion(text: string, version: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (!('name' in pkg)) out.version = version;
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'version') continue;
    out[key] = value;
    if (key === 'name') out.version = version;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Version of each package.json (null when it has none). */
export async function readVersions(root = ROOT): Promise<Record<string, string | null>> {
  const versions: Record<string, string | null> = {};
  for (const file of PACKAGE_FILES) {
    const pkg = JSON.parse(await readFile(`${root}/${file}`, 'utf8')) as { version?: unknown };
    versions[file] = typeof pkg.version === 'string' ? pkg.version : null;
  }
  return versions;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { check: { type: 'string' } },
    strict: true,
    allowPositionals: true,
  });

  if (values.check !== undefined) {
    const expected = parseVersion(values.check);
    if (!expected) {
      console.error(`release: “${values.check}” is not a version tag (v1.2.3)`);
      process.exit(2);
    }
    const wrong = Object.entries(await readVersions()).filter(([, v]) => v !== expected);
    if (wrong.length > 0) {
      for (const [file, v] of wrong)
        console.error(`release: ${file} is at ${v ?? 'no version'}, the tag at ${expected}`);
      console.error(`release: run \`bun run release ${expected}\` and merge it before tagging`);
      process.exit(1);
    }
    console.log(`release: every package.json is at ${expected}`);
  } else {
    const version = positionals.length === 1 ? parseVersion(positionals[0] as string) : null;
    if (!version) {
      console.error('usage: bun run release <version>   (for example 0.2.0)');
      process.exit(2);
    }
    for (const file of PACKAGE_FILES) {
      const path = `${ROOT}/${file}`;
      await writeFile(path, withVersion(await readFile(path, 'utf8'), version));
    }
    console.log(`release: ${PACKAGE_FILES.join(', ')} set to ${version}`);
    console.log(
      `next: commit it through a PR, then once merged: git tag v${version} origin/master && git push origin v${version}`,
    );
  }
}
