// The package's contract as a future npm library: no dependency on the app, tree-shakeable. Node APIs only: its
// project (tsconfig.json) has Node's types alone, so `tsc -b` refuses anything else.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
  sideEffects: boolean;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
};
const sources = (await readdir(SRC)).filter((f) => f.endsWith('.ts'));

test('the sources import nothing from the monorepo', async () => {
  for (const f of sources) {
    const text = await readFile(join(SRC, f), 'utf8');
    assert.deepEqual({ f, app: /@llama-webui\//.test(text) }, { f, app: false });
    // Node runs the sources as they are: a relative import names its .ts file.
    assert.deepEqual({ f, bare: /from '\.\/[^']*(?<!\.ts)'/.test(text) }, { f, bare: false });
  }
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test('every module has its own export and the package has no side effects', () => {
  assert.equal(pkg.sideEffects, false);
  const exported = new Set(Object.values(pkg.exports).map((p) => p.replace('./src/', '')));
  for (const f of sources) assert.deepEqual({ f, exported: exported.has(f) }, { f, exported: true });
});

// The bundling checks use Rolldown (Vite's bundler, a devDependency): skipped where the package has no install, as
// in the Node 24 CI job.
const bundler = await import('rolldown').catch(() => null);
const needsBundler = { skip: bundler ? false : 'needs rolldown (pnpm install)' };

const tmp = await mkdtemp(join(tmpdir(), 'llamacpp-js-'));
after(() => rm(tmp, { recursive: true, force: true }));

/** The bundle of an entry that imports `names` from `spec` (a path of the package). */
async function bundle(spec: string, names: string[]): Promise<string> {
  const entry = join(tmp, `${names.join('-')}.ts`);
  await writeFile(
    entry,
    `import { ${names.join(', ')} } from ${JSON.stringify(join(ROOT, spec))};\nconsole.log(${names.join(', ')});\n`,
  );
  const build = await bundler!.rolldown({ input: entry, platform: 'browser', logLevel: 'silent' });
  try {
    const { output } = await build.generate({ format: 'esm' });
    return output[0].code;
  } finally {
    await build.close();
  }
}

test('importing one function from the root keeps only what it needs', needsBundler, async () => {
  const js = await bundle('src/index.ts', ['parseHelp']);
  assert.ok(js.includes('function parseHelp'));
  for (const unused of ['streamChatCompletion', 'SseParser', 'parsePrometheus', 'LlamaHttpError', 'parseBenchJson'])
    assert.deepEqual({ unused, kept: js.includes(unused) }, { unused, kept: false });
});

test('the browser-safe modules bundle for the browser without Node built-ins', needsBundler, async () => {
  const js = await bundle('src/index.ts', ['streamChatCompletion', 'fetchLlama', 'parseBenchJson', 'describeFlag']);
  assert.doesNotMatch(js, /node:|child_process/);
});
