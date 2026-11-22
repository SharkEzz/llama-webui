// The web client (React): the base, the React rules and the Vitest rules.
import { defineConfig } from 'oxlint';
import { base } from '../../oxlint.config.ts';
import { react } from '../../oxlint.react.ts';
import { tests } from '../../oxlint.tests.ts';

export default defineConfig({
  extends: [base, react, tests],
  rules: {
    // The page logs nothing to the console but what it cannot show (a suppression says which)
    'no-console': 'error',
  },
  // shadcn components keep their default code
  ignorePatterns: ['components/ui/**'],
});
