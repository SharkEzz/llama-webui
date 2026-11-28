// @llama-webui/shared (schemas, pure logic and the API definition, for the server and the web): the base and the
// Vitest rules. None of the root config's `ignorePatterns` falls under this directory, so it repeats none.
import { defineConfig } from 'oxlint';
import { bans, base, llamacppNode, nodeBuiltins } from '../../oxlint.config.ts';
import { tests } from '../../scripts/oxlint/oxlint.tests.ts';

const browser = 'shared code runs in the browser';
// The app, by its package name or a relative path out of the package (`../../../app/…`)
const app = { regex: '^((\\.\\./)+app|@llama-webui/app)(/|$)', message: browser };

export default defineConfig({
  extends: [base, tests],
  rules: {
    ...bans([app, llamacppNode, { ...nodeBuiltins, message: browser }]),
  },
  overrides: [
    {
      // A test may use Node (its modules, `llamacpp-js/node`): it reads a fixture, runs a child Node
      files: ['**/*.test.ts'],
      rules: bans([app]),
    },
  ],
});
