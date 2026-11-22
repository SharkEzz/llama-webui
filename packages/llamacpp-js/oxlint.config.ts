// llamacpp-js (published, tests on node:test): the base alone, no Vitest rule.
import { defineConfig } from 'oxlint';
import { base } from '../../oxlint.config.ts';

export default defineConfig({
  extends: [base],
  overrides: [
    {
      // The helpers of the tests cast their fixtures and stubs like the tests (`overrides` of the base)
      files: ['tests/**'],
      rules: { 'typescript/no-unsafe-type-assertion': 'off' },
    },
  ],
});
