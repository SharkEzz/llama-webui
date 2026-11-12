import { expect, test } from 'vitest';
import { declarationImports } from './declarations';
import { tempDir } from './tempDir';
import { writeFileDeep } from './write';

test('declarationImports follows relative declarations and lists every other specifier with its importer', async () => {
  using dir = tempDir('lw-dts-');
  await writeFileDeep(`${dir.path}/rpc.d.ts`, 'export type A = import("./http").B & import("hono/types").C;\n');
  await writeFileDeep(
    `${dir.path}/http.d.ts`,
    'import type { Stats } from \'node:fs\';\nexport type B = { s: Stats; d: import("./deep/x").X };\n',
  );
  await writeFileDeep(`${dir.path}/deep/x.d.ts`, "export * from 'vite';\nexport type X = 1;\n");
  expect(declarationImports(`${dir.path}/rpc.d.ts`)).toEqual([
    'hono/types (rpc.d.ts)',
    'node:fs (http.d.ts)',
    'vite (deep/x.d.ts)',
  ]);
});
