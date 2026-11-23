// The web client (React): the base, the React rules, the Vitest rules and the Tailwind rules.
import { defineConfig } from 'oxlint';
import { react } from '../../configs/oxlint.react.ts';
import { tailwind } from '../../configs/oxlint.tailwind.ts';
import { tests } from '../../configs/oxlint.tests.ts';
import { base, llamacppNode, nodeBuiltins, vendored } from '../../oxlint.config.ts';

const web = 'the web talks to the server through `@llama-webui/shared` and `lib/api.ts`';
// `app/server/`, by its package path or a relative path out of `src/` (`../server/…`, `../../app/server/…`). A
// relative `../server/` between two folders of `src/` would be reported too: `src/` imports its own files by `@/`
const server = { regex: '^((@/)?(\\.\\./)+(app/)?|@llama-webui/app/)server(/|$)', message: web };

export default defineConfig({
  extends: [base, react, tests, tailwind],
  // The stylesheet the Tailwind rules read (it imports Tailwind and the theme), relative to this file
  settings: { tailwindcss: { entryPoint: 'index.css' } },
  rules: {
    // The page logs nothing to the console but what it cannot show (a suppression says which)
    'no-console': 'error',
    'no-restricted-imports': [
      'error',
      { patterns: [vendored, server, llamacppNode, { ...nodeBuiltins, message: web }] },
    ],
  },
  overrides: [
    {
      // A test may use Node (its modules, `llamacpp-js/node`)
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: { 'no-restricted-imports': ['error', { patterns: [vendored, server] }] },
    },
  ],
  // shadcn components keep their default code
  ignorePatterns: ['components/ui/**'],
});
