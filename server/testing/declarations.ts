import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** `from '…'`, `import('…')` and `import("…")` specifiers of a declaration file. */
const SPECIFIER = /(?:from\s+|import\(\s*)(['"])([^'"]+)\1/g;

/**
 * Every non-relative module a declaration file reaches, following its relative imports (`./http` → `http.d.ts`):
 * `<specifier> (<importer, relative to the entry's folder>)`, sorted. With `skipLibCheck`, a declaration that imports a
 * module the reader cannot resolve (`node:fs` in a project without Node's types) gives `any` without an error: this
 * lists what the declaration needs instead.
 */
export function declarationImports(entry: string): string[] {
  const root = dirname(entry);
  const seen = new Set<string>();
  const out = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, , spec] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (spec?.startsWith('.')) visit(`${resolve(dirname(file), spec.replace(/\.js$/, ''))}.d.ts`);
      else if (spec) out.add(`${spec} (${relative(root, file)})`);
    }
  };
  visit(entry);
  return [...out].sort();
}
