// The package's contract as a future npm library: no dependency on the app, no Bun API, tree-shakeable.
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

test('the sources import nothing from the monorepo and use no Bun API', async () => {
  for (const f of sources) {
    const text = await readFile(join(SRC, f), 'utf8');
    assert.deepEqual({ f, app: /@llama-webui\//.test(text) }, { f, app: false });
    assert.deepEqual({ f, bun: /\bBun\.|from ['"]bun/.test(text) }, { f, bun: false });
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

// The bundling checks use Bun's bundler: they run under `bun test` and are skipped under `node --test`.
interface Bundler {
  build(o: { entrypoints: string[]; target: 'browser'; minify: boolean }): Promise<{
    success: boolean;
    outputs: { text(): Promise<string> }[];
  }>;
}
const bundler = (globalThis as { Bun?: Bundler }).Bun;
const needsBun = { skip: bundler ? false : 'needs Bun.build (run under bun test)' };

const tmp = await mkdtemp(join(tmpdir(), 'llamacpp-js-'));
after(() => rm(tmp, { recursive: true, force: true }));

/** The bundle of an entry that imports `names` from `spec` (a path of the package). */
async function bundle(spec: string, names: string[]): Promise<string> {
  const entry = join(tmp, `${names.join('-')}.ts`);
  await writeFile(
    entry,
    `import { ${names.join(', ')} } from ${JSON.stringify(join(ROOT, spec))};\nconsole.log(${names.join(', ')});\n`,
  );
  const out = await bundler!.build({ entrypoints: [entry], target: 'browser', minify: false });
  assert.equal(out.success, true);
  return out.outputs[0]!.text();
}

test('importing one function from the root keeps only what it needs', needsBun, async () => {
  const js = await bundle('src/index.ts', ['parseHelp']);
  assert.ok(js.includes('function parseHelp'));
  for (const unused of ['streamChatCompletion', 'SseParser', 'parsePrometheus', 'LlamaHttpError', 'parseBenchJson'])
    assert.deepEqual({ unused, kept: js.includes(unused) }, { unused, kept: false });
});

test('the browser-safe modules bundle for the browser without Node built-ins', needsBun, async () => {
  const js = await bundle('src/index.ts', ['streamChatCompletion', 'fetchLlama', 'parseBenchJson', 'describeFlag']);
  assert.doesNotMatch(js, /node:|child_process/);
});
