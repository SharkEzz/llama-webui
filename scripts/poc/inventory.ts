/**
 * Inventory of every Vitest test, with the milestone of the Effect POC that ports it: the list the final report counts
 * tests against (ported, rewritten, dropped).
 * - `node scripts/poc/inventory.ts --out <file.json>`: lists the tests (`vitest list`) and writes the inventory.
 * The tests of `packages/llamacpp-js` (`node:test`) are not listed: the package does not change.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '../..');

export type Milestone = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'keep';

/** Repo-relative prefixes (a folder ends with `/`), first match wins. */
const PREFIXES: [Milestone, string[]][] = [
  [
    'E1',
    [
      'app/server/api.gen.test.ts',
      'app/server/build.test.ts',
      'app/server/dev.test.ts',
      'app/server/lifecycle.test.ts',
      'app/build/',
      'app/server/lib/cli.test.ts',
      'app/server/lib/env.test.ts',
      'app/server/lib/http.test.ts',
      'app/server/lib/proc.test.ts',
      'app/server/lib/security.test.ts',
      'app/server/lib/version.test.ts',
      'app/server/lib/contract/',
      'app/server/lib/db/migrations.test.ts',
      'app/server/lib/db/settings.test.ts',
      'app/server/lib/db/sqlite.test.ts',
      'app/src/lib/api.test.ts',
    ],
  ],
  ['E2', ['app/server/lib/schemas.test.ts', 'packages/webui-shared/src/profile.test.ts', 'app/src/features/profiles/']],
  [
    'E3',
    [
      'app/server/lib/supervisor/',
      'app/server/lib/logs/',
      'app/server/lib/llamaFetch.test.ts',
      'packages/webui-shared/src/logs.test.ts',
      'app/src/lib/props.test.ts',
    ],
  ],
  [
    'E4',
    [
      'app/server/lib/collectors/',
      'app/server/lib/hardware/',
      'app/server/lib/monitor/',
      'packages/webui-shared/src/topology.test.ts',
    ],
  ],
  ['E5', ['app/server/lib/chat/', 'packages/webui-shared/src/chat.test.ts']],
  [
    'E6',
    [
      'app/server/lib/models/',
      'app/server/lib/hf/',
      'packages/webui-shared/src/models.test.ts',
      'packages/webui-shared/src/hf.test.ts',
    ],
  ],
  [
    'E7',
    [
      'app/server/lib/bench/',
      'app/server/lib/db/benchRuns.test.ts',
      'app/server/lib/db/sweeps.test.ts',
      'packages/webui-shared/src/bench.test.ts',
      'packages/webui-shared/src/sweep.test.ts',
      'app/src/lib/bench.test.ts',
    ],
  ],
  [
    'E8',
    [
      'app/server/lib/tuning/',
      'app/server/lib/setup.test.ts',
      'packages/webui-shared/src/setup.test.ts',
      'app/src/lib/tuning.test.ts',
    ],
  ],
  [
    'keep',
    [
      'scripts/',
      'site/',
      'packages/webui-shared/src/format.test.ts',
      'packages/webui-shared/src/dispose.test.ts',
      'app/src/app/',
      'app/src/features/topology/',
    ],
  ],
];

/** Tests route handlers of several domains: its tests are placed by name, not by file. */
const BY_NAME_FILE = 'app/server/lib/routes.test.ts';

/** For `BY_NAME_FILE`, in order: the first word the test name contains gives the milestone. */
const BY_NAME: [string, Milestone][] = [
  ['chat', 'E5'],
  ['stream', 'E5'],
  ['bench', 'E7'],
  ['props', 'E3'],
  ['settings', 'E1'],
  // The WebSocket hub and the settings' `pollIntervalMs` cap: E1's hub and settings.
  ['WsHub', 'E1'],
  ['pollIntervalMs', 'E1'],
];

/** The milestone that ports the tests of a repo-relative test file; `keep` when the rewrite does not touch them. */
export function milestoneOf(file: string): Milestone {
  for (const [milestone, prefixes] of PREFIXES) {
    if (prefixes.some((p) => file.startsWith(p))) return milestone;
  }
  throw new Error(`no milestone for ${file}`);
}

/** The milestone of one test of `BY_NAME_FILE`. */
export function milestoneByName(name: string): Milestone {
  for (const [word, milestone] of BY_NAME) if (name.includes(word)) return milestone;
  throw new Error(`no milestone for ${BY_NAME_FILE}: ${name}`);
}

export interface InventoryEntry {
  /** Vitest project: server, shared, web, site. */
  project: string;
  /** Repo-relative. */
  file: string;
  /** Full test name as `vitest list` prints it. */
  name: string;
  milestone: Milestone;
  /** Filled by the milestone that handles the test; absent in the baseline. */
  status?: 'ported' | 'rewritten' | 'dropped';
  /** Repo-relative file of the new test (`ported`, `rewritten`). */
  to?: string;
  /** Why (`dropped`: mandatory). */
  reason?: string;
}

interface Listed {
  name: string;
  file: string;
  projectName: string;
}

/**
 * Every test as Vitest collects it by running the files (`--staticParse=false`): a static parse would list a
 * `test.each` once with its `%s` template and drop a `test.skipIf`. No build (`LLAMA_WEBUI_TEST_BUILD=0`).
 */
function listTests(): Listed[] {
  const dir = mkdtempSync(join(tmpdir(), 'llama-webui-inventory-'));
  try {
    const out = join(dir, 'list.json');
    const r = spawnSync('pnpm', ['exec', 'vitest', 'list', `--json=${out}`, '--staticParse=false'], {
      cwd: ROOT,
      env: { ...process.env, LLAMA_WEBUI_TEST_BUILD: '0' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (r.status !== 0) throw new Error(`vitest list failed (${r.status ?? r.signal})`);
    return JSON.parse(readFileSync(out, 'utf8')) as Listed[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function inventory(listed: Listed[]): InventoryEntry[] {
  const entries = listed.map((t): InventoryEntry => {
    const file = relative(ROOT, t.file).split('\\').join('/');
    const milestone = file === BY_NAME_FILE ? milestoneByName(t.name) : milestoneOf(file);
    return { project: t.projectName, file, name: t.name, milestone };
  });
  // Stable: the order of the listing within a file is kept.
  return entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (values.out === undefined) {
    console.error('usage: node scripts/poc/inventory.ts --out <file.json>');
    process.exit(2);
  }
  const entries = inventory(listTests());
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`wrote ${entries.length} tests to ${out}`);
}
