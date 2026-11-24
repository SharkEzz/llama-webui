// React rules, for the projects that render React (app/src, site).
import type { OxlintConfig } from 'oxlint';

export const react: OxlintConfig = {
  plugins: ['react', 'jsx-a11y'],
  // react-doctor: the plugin alone, ten of its rules and no other (spec, "react-doctor")
  jsPlugins: [{ name: 'react-doctor', specifier: 'oxlint-plugin-react-doctor' }],
  rules: {
    // The JSX transform of React 17+ needs no `React` in scope
    'react/react-in-jsx-scope': 'off',

    // Parity rules outside `correctness` (measurements, §1 "Kept")
    'react/button-has-type': 'error',
    'react/jsx-no-comment-textnodes': 'error',
    'react/jsx-no-script-url': 'error',
    'react/jsx-no-target-blank': 'error',
    'react/no-array-index-key': 'error',
    'react/no-danger': 'error',
    'react/no-namespace': 'error',
    'react/rules-of-hooks': 'error',
    'jsx-a11y/anchor-ambiguous-text': 'error',
    'react/jsx-no-useless-fragment': 'error',
    'react/no-object-type-as-default-prop': 'error',
    'react/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['links', 'meta'] }],

    // The React selection (spec, "The selection" › L5)
    'react/no-unescaped-entities': 'error',
    'react/hooks': 'error',
    'react/exhaustive-effect-dependencies': 'error',

    // react-doctor (the tenth, for the site only, is in site/oxlint.config.ts)
    'react-doctor/no-mirror-prop-effect': 'error',
    'react-doctor/no-reset-all-state-on-prop-change': 'error',
    'react-doctor/no-set-state-after-await-in-effect': 'error',
    'react-doctor/no-loading-flag-reset-outside-finally': 'error',
    'react-doctor/no-impure-state-updater': 'error',
    'react-doctor/zustand-no-whole-store-destructure': 'error',
    'react-doctor/no-enter-submit-without-ime-composition-guard': 'error',
    'react-doctor/react-router-require-root-error-boundary': 'error',
    'react-doctor/rerender-state-only-in-handlers': 'error',

    // Accessibility is out of scope for now: the jsx-a11y rules that report on today's code are off
    // 7 reports: an element carries its role on purpose (`meter` on an <svg>, `combobox`, `status`)
    'jsx-a11y/prefer-tag-over-role': 'off',
    // 3 reports: the field a click just opened (rename, a search, an edit) takes the focus on purpose
    'jsx-a11y/no-autofocus': 'off',
    // 3 reports: not a parity rule; a `Button` rendered as a link (`render={<a … />}`) is labelled by its text
    'jsx-a11y/control-has-associated-label': 'off',
    // 2 reports: not a parity rule; the logs' scrolling area and the per-core list handle keys and the pointer
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
  },
};
