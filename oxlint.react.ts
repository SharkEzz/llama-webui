// React rules, for the projects that render React (app/src, site).
import type { OxlintConfig } from 'oxlint';

export const react: OxlintConfig = {
  plugins: ['react', 'jsx-a11y'],
  rules: {
    // The JSX transform of React 17+ needs no `React` in scope
    'react/react-in-jsx-scope': 'off',

    // Biome equivalents outside `correctness` (measurements, §1 "Kept")
    'react/button-has-type': 'error',
    'react/jsx-no-comment-textnodes': 'error',
    'react/jsx-no-script-url': 'error',
    'react/jsx-no-target-blank': 'error',
    'react/no-array-index-key': 'error',
    'react/no-danger': 'error',
    'react/no-namespace': 'error',
    'react/rules-of-hooks': 'error',
    'jsx-a11y/anchor-ambiguous-text': 'error',
    // The two React rules that report today (react/jsx-no-useless-fragment, react/no-object-type-as-default-prop)
    // are in the debt block of the base.

    // Accessibility is out of scope for now: only the Biome equivalents that pass today are on
    // Biome equivalents stricter than Biome's (`useSemanticElements`, `noAutofocus`): they report where Biome passes
    'jsx-a11y/prefer-tag-over-role': 'off',
    'jsx-a11y/no-autofocus': 'off',
    // Not Biome rules
    'jsx-a11y/control-has-associated-label': 'off',
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
  },
};
