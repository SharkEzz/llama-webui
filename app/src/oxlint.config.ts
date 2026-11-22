// The web client (React): the base, the React rules, the Vitest rules and the Tailwind rules.
import { defineConfig } from 'oxlint';
import { base } from '../../oxlint.config.ts';
import { react } from '../../oxlint.react.ts';
import { tailwind } from '../../oxlint.tailwind.ts';
import { tests } from '../../oxlint.tests.ts';

export default defineConfig({
  extends: [base, react, tests, tailwind],
  // The stylesheet the Tailwind rules read (it imports Tailwind and the theme), relative to this file
  settings: { tailwindcss: { entryPoint: 'index.css' } },
  rules: {
    // The page logs nothing to the console but what it cannot show (a suppression says which)
    'no-console': 'error',
  },
  // shadcn components keep their default code
  ignorePatterns: ['components/ui/**'],
});
