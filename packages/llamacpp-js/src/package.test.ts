// The package's contract as a future npm library: no dependency on the app, no Bun API, tree-shakeable.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const pkg = (await Bun.file(join(ROOT, 'package.json')).json()) as {
  sideEffects: boolean;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
};
const sources = (await readdir(import.meta.dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const tmp = await mkdtemp(join(tmpdir(), 'llamacpp-js-'));
afterAll(() => rm(tmp, { recursive: true, force: true }));

test('the sources import nothing from the monorepo and use no Bun API', async () => {
  for (const f of sources) {
    const text = await Bun.file(join(import.meta.dir, f)).text();
    expect({ f, app: /@llama-webui\//.test(text) }).toEqual({ f, app: false });
    expect({ f, bun: /\bBun\.|from ['"]bun/.test(text) }).toEqual({ f, bun: false });
    // Node runs the sources as they are: a relative import names its .ts file.
    expect({ f, bare: /from '\.\/[^']*(?<!\.ts)'/.test(text) }).toEqual({ f, bare: false });
  }
  expect(pkg.dependencies ?? {}).toEqual({});
});

test('every module has its own export and the package has no side effects', () => {
  expect(pkg.sideEffects).toBe(false);
  const exported = new Set(Object.values(pkg.exports).map((p) => p.replace('./src/', '')));
  for (const f of sources) expect({ f, exported: exported.has(f) }).toEqual({ f, exported: true });
});

/** The bundle of an entry that imports `names` from `spec` (a path of the package). */
async function bundle(spec: string, names: string[]): Promise<string> {
  const entry = join(tmp, `${names.join('-')}.ts`);
  await writeFile(
    entry,
    `import { ${names.join(', ')} } from ${JSON.stringify(join(ROOT, spec))};\nconsole.log(${names.join(', ')});\n`,
  );
  const out = await Bun.build({ entrypoints: [entry], target: 'browser', minify: false });
  expect(out.success).toBe(true);
  return out.outputs[0]!.text();
}

test('importing one function from the root keeps only what it needs', async () => {
  const js = await bundle('src/index.ts', ['parseHelp']);
  expect(js).toContain('function parseHelp');
  for (const unused of ['streamChatCompletion', 'SseParser', 'parsePrometheus', 'LlamaHttpError', 'parseBenchJson'])
    expect({ unused, kept: js.includes(unused) }).toEqual({ unused, kept: false });
});

test('the browser-safe modules bundle for the browser without Node built-ins', async () => {
  const js = await bundle('src/index.ts', ['streamChatCompletion', 'fetchLlama', 'parseBenchJson', 'describeFlag']);
  expect(js).not.toMatch(/node:|child_process/);
});
