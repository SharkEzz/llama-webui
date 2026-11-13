import { expect, test } from 'vitest';
import { packageRoot, render } from './licenses.ts';

test('packageRoot finds the package of a bundled module, scoped or not, through pnpm', () => {
  const pnpm = '/r/node_modules/.pnpm/h3@2.0.8/node_modules';
  expect(packageRoot(`${pnpm}/h3/dist/index.mjs`)).toBe(`${pnpm}/h3`);
  expect(packageRoot('/r/node_modules/@huggingface/gguf/dist/index.js')).toBe('/r/node_modules/@huggingface/gguf');
  expect(packageRoot('/r/app/server/lib/http.ts')).toBeNull();
  expect(packageRoot('/r/node_modules/@scope')).toBeNull();
});

test('render sorts by name and says when a package ships no license file', () => {
  const text = render([
    { name: 'zod', version: '4.0.0', license: 'MIT', text: 'MIT License' },
    { name: 'h3', version: '2.0.0', license: 'MIT', text: null },
  ]);
  expect(text.indexOf('## h3 - 2.0.0 (MIT)')).toBeLessThan(text.indexOf('## zod - 4.0.0 (MIT)'));
  expect(text).toContain('No license file; package.json: MIT.');
});
