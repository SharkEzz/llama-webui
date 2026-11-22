// The public site (React, prerendered): the base, the React rules and the Vitest rules.
import { defineConfig } from 'oxlint';
import { base } from '../oxlint.config.ts';
import { react } from '../oxlint.react.ts';
import { tests } from '../oxlint.tests.ts';

export default defineConfig({
  extends: [base, react, tests],
  rules: {
    // The site prerenders: a browser global read during render or in a hook's initial state breaks the build
    'react-doctor/no-unguarded-browser-global-in-render-or-hook-init': 'error',
  },
  ignorePatterns: [
    // shadcn components keep their default code
    'src/components/ui/**',
    // Build outputs and generated types
    'build',
    'dist',
    '.react-router',
  ],
});
