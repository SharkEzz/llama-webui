// The public site (React, prerendered): the base, the React rules, the Vitest rules and the Tailwind rules.
import { defineConfig } from 'oxlint';
import { react } from '../configs/oxlint.react.ts';
import { tailwind } from '../configs/oxlint.tailwind.ts';
import { tests } from '../configs/oxlint.tests.ts';
import { base, vendored } from '../oxlint.config.ts';

const copies = 'the site copies what it reuses; tokens come from `@llama-webui/theme`';
// Anything of `app/`, by its package name or a relative path out of `site/` (`../app/…`, `../../../app/src/…`); and
// `@llama-webui/shared`, which the site does not use, by its name or a relative path (`../../packages/webui-shared/…`)
const app = { regex: '^((@/)?(\\.\\./)+app|@llama-webui/app)(/|$)', message: copies };
const shared = { regex: '^(@llama-webui/shared|(@/)?(\\.\\./)+packages/webui-shared)(/|$)', message: copies };

export default defineConfig({
  extends: [base, react, tests, tailwind],
  // The stylesheet the Tailwind rules read (it imports Tailwind and the theme), relative to this file
  settings: { tailwindcss: { entryPoint: 'src/styles/app.css' } },
  rules: {
    // The site prerenders: a browser global read during render or in a hook's initial state breaks the build
    'react-doctor/no-unguarded-browser-global-in-render-or-hook-init': 'error',
    'no-restricted-imports': ['error', { patterns: [vendored, app, shared] }],
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
