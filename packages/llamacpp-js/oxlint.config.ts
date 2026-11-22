// llamacpp-js (published, tests on node:test): the base alone, no Vitest rule.
import { defineConfig } from 'oxlint';
import { base, nodeBuiltins, vendored } from '../../oxlint.config.ts';

const standalone = 'the package has no dependency; Node APIs live behind `llamacpp-js/node`';
// llama-webui's packages, by name or by a relative path out of the package (`../../webui-shared/…`, `../../../app/…`)
const webui = { regex: '^(@llama-webui/|(\\.\\./)+(app|(packages/)?webui-[a-z]+)(/|$))', message: standalone };
const effect = { regex: '^(effect|@effect/[^/]+)(/|$)', message: standalone };

export default defineConfig({
  extends: [base],
  rules: {
    'no-restricted-imports': [
      'error',
      { patterns: [vendored, webui, effect, { ...nodeBuiltins, message: standalone }] },
    ],
  },
  overrides: [
    {
      // The helpers of the tests cast their fixtures and stubs like the tests (`overrides` of the base)
      files: ['tests/**'],
      rules: { 'typescript/no-unsafe-type-assertion': 'off' },
    },
    {
      // Node's modules: in the `llamacpp-js/node` export (`exports` of `package.json`) and in the tests
      files: ['src/node.ts', 'tests/**'],
      rules: { 'no-restricted-imports': ['error', { patterns: [vendored, webui, effect] }] },
    },
  ],
});
