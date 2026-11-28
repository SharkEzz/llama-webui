import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const oxlint = join(root, 'node_modules', '.bin', 'oxlint');
const plugin = join(import.meta.dirname, 'imports.ts');
const rule = 'imports/no-restricted-calls';

const patterns = [{ regex: '^node:', message: 'no Node here' }, { regex: '^forbidden(/|$)' }];

const files: Record<string, string> = {
  'require.ts': [
    "require('node:fs');",
    "require('allowed');",
    "require.resolve('node:path');",
    "createRequire(import.meta.url)('forbidden/x');",
    'require(`node:os`);',
  ].join('\n'),
  'import.ts': [
    'declare const name: string;',
    'await import(`node:fs`);',
    'await import(`allowed`);',
    'await import(name);',
    // oxlint-disable-next-line no-template-curly-in-string -- the source of a fixture: a template literal with an expression
    'await import(`${name}/x.js`);',
    // A string literal is the business of `no-restricted-imports`
    "await import('node:fs');",
  ].join('\n'),
  'vi.ts': [
    'declare const path: string;',
    "vi.mock('node:fs');",
    "vi.doMock('forbidden');",
    "vi.importActual('allowed');",
    "vi.mock(import('node:os'));",
    'vi.mock(path);',
    "vi.fn('node:fs');",
    "other.mock('node:fs');",
    "vi.importMock('node:child_process');",
  ].join('\n'),
};

const dir = mkdtempSync(join(tmpdir(), 'lw-imports-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Diagnostic {
  message: string;
  code: string;
  filename: string;
  labels: Array<{ span: { line: number } }>;
}

const lint = (): Diagnostic[] => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), `${text}\n`);
  const config = { jsPlugins: [plugin], rules: { [rule]: ['error', { patterns }] } };
  writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));
  const run = spawnSync(oxlint, ['-f', 'json', '.'], { cwd: dir, encoding: 'utf8' });
  expect(run.stderr).toBe('');
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
  return diagnostics.filter((d) => d.code === 'imports(no-restricted-calls)');
};

let reports: Diagnostic[] = [];
beforeAll(() => {
  reports = lint();
});
const at = (file: string) => reports.filter((d) => d.filename === file).map((d) => d.labels[0]?.span.line);
const messageAt = (file: string, line: number) =>
  reports.find((d) => d.filename === file && d.labels[0]?.span.line === line)?.message;

test('require, require.resolve and createRequire are checked against the bans (#122)', () => {
  expect(at('require.ts')).toEqual([1, 3, 4, 5]);
});

test('an import() of a template without expressions is checked; one known only at run time is refused (#122)', () => {
  expect(at('import.ts')).toEqual([2, 4, 5]);
  expect(messageAt('import.ts', 4)).toMatch(/^A module path known only at run time escapes the import bans/);
});

test('the module path of vi.mock and its kin is checked; other calls are not (#122)', () => {
  expect(at('vi.ts')).toEqual([2, 3, 6, 9]);
});

test('the message names the path and the reason of its pattern (#122)', () => {
  expect(messageAt('require.ts', 1)).toBe("'node:fs' is restricted from being used by a pattern: no Node here.");
  expect(messageAt('require.ts', 4)).toBe("'forbidden/x' is restricted from being used by a pattern.");
});

describe('every project sets both rules with the same bans (#122)', () => {
  type Rules = Record<string, unknown>;
  interface Printed {
    rules: Rules;
    overrides?: Array<{ files: string[]; rules?: Rules }>;
  }
  const projects = ['app/server', 'app/src', 'site', 'packages/llamacpp-js', 'packages/webui-shared'];

  test.each(projects)('%s', (project) => {
    const run = spawnSync(oxlint, ['-c', join(project, 'oxlint.config.ts'), '--print-config'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const printed = JSON.parse(run.stdout) as Printed;
    expect(printed.rules['no-restricted-imports']).toBeDefined();
    for (const rules of [printed.rules, ...(printed.overrides ?? []).map((o) => o.rules ?? {})]) {
      expect(rules[rule]).toEqual(rules['no-restricted-imports']);
    }
  });
});
