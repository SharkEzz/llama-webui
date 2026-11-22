// llamacpp-js (published, tests on node:test): the base alone, no Vitest rule.
import { defineConfig } from 'oxlint';
import { base } from '../../oxlint.config.ts';

export default defineConfig({ extends: [base] });
