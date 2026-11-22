// The public site (React, prerendered): the base, the React rules, the Vitest rules and the Tailwind rules.
import { defineConfig } from 'oxlint';
import { base } from '../oxlint.config.ts';
import { react } from '../oxlint.react.ts';
import { tests } from '../oxlint.tests.ts';

export default defineConfig({
  extends: [base, react, tests],
  jsPlugins: ['oxlint-tailwindcss'],
  // The stylesheet that imports Tailwind and the theme (relative to this file)
  settings: { tailwindcss: { entryPoint: 'src/styles/app.css' } },
  rules: {
    // The site prerenders: a browser global read during render or in a hook's initial state breaks the build
    'react-doctor/no-unguarded-browser-global-in-render-or-hook-init': 'error',
    // oxlint-tailwindcss: its recommended rules, all in error
    'tailwindcss/no-conflicting-classes': 'error',
    'tailwindcss/no-contradicting-variants': 'error',
    'tailwindcss/no-dark-without-light': 'error',
    'tailwindcss/no-duplicate-classes': 'error',
    'tailwindcss/no-dynamic-classes': 'error',
    'tailwindcss/no-unknown-classes': [
      'error',
      // The ambient background of @llama-webui/theme (theme.css): plain classes, not utilities
      { allowlist: ['aurora', 'glow', 'glow-1', 'glow-2', 'glow-3'] },
    ],
    'tailwindcss/enforce-canonical': 'error',
    'tailwindcss/enforce-negative-arbitrary-values': 'error',
    'tailwindcss/no-deprecated-classes': 'error',
    'tailwindcss/no-unnecessary-arbitrary-value': 'error',
    'tailwindcss/consistent-variant-order': 'error',
    'tailwindcss/enforce-consistent-important-position': 'error',
    'tailwindcss/enforce-consistent-variable-syntax': 'error',
    'tailwindcss/enforce-shorthand': 'error',
    'tailwindcss/no-unnecessary-whitespace': 'error',
    'tailwindcss/no-hardcoded-colors': 'error',
    // oxfmt owns the class order and the wrapping (sortTailwindcss in oxfmt.config.ts): the two orders disagree
    'tailwindcss/enforce-sort-order': 'off',
    'tailwindcss/enforce-consistent-line-wrapping': 'off',
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
