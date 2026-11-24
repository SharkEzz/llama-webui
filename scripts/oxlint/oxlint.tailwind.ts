// Tailwind rules, for the projects styled with Tailwind (app/src, site): each sets its own stylesheet,
// `settings.tailwindcss.entryPoint`, relative to its config file.
import type { OxlintConfig } from 'oxlint';

export const tailwind: OxlintConfig = {
  // oxlint-tailwindcss: its recommended rules, all in error (spec, "Tailwind (L6)")
  jsPlugins: ['oxlint-tailwindcss'],
  rules: {
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
    // oxfmt is the single owner of the class order and the wrapping (sortTailwindcss in oxfmt.config.ts)
    'tailwindcss/enforce-sort-order': 'off',
    'tailwindcss/enforce-consistent-line-wrapping': 'off',
  },
};
