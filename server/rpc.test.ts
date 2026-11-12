import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { declarationImports } from './testing/declarations';

/** What the API's declaration may import: the web resolves these without Bun's or Node's types. */
const ALLOWED = /^(hono|hono\/.+|zod|zod\/.+|@llama-webui\/shared|llamacpp-js\/metrics)$/;

test("the API's declaration (the web's typed client) imports no Node, Bun or other app module", async () => {
  // Fresh declarations: `tsc -b` skips an unchanged project.
  await promisify(execFile)(`${import.meta.dirname}/../node_modules/.bin/tsc`, ['-b', `${import.meta.dirname}`]);
  const imports = declarationImports(`${import.meta.dirname}/.tsbuild/rpc.d.ts`);
  expect(imports.length).toBeGreaterThan(0);
  // A `node:fs` type there would be `any` in the web (`skipLibCheck`, no Node types), and its canary would miss it.
  expect(imports.filter((i) => !ALLOWED.test(i.split(' ')[0] ?? ''))).toEqual([]);
}, 60_000);
