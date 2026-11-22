// The base of every oxlint config: plugins, categories, type-aware rules and the selection that applies to all code.
// As the root config it covers scripts/, app/build, app/bin, packages/webui-shared and the root files;
// each other project has its own `oxlint.config.ts`, which extends `base` (a nested config replaces this one).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'oxlint';
import { tests } from './oxlint.tests.ts';

export const base = defineConfig({
  plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise'],
  // An absolute path: oxlint refuses a relative plugin path in a config that another one `extends`
  jsPlugins: [fileURLToPath(import.meta.resolve('./scripts/oxlint/directives.ts'))],
  // tsgolint finds the tsconfig.json of each file; a file outside every project (the root files, app/bin) gets an
  // inferred one: no configuration error, and the type-aware rules still report there (checked at L3)
  options: { typeAware: true },
  categories: { correctness: 'error', suspicious: 'error', perf: 'error' },
  rules: {
    // A suppression names its rule and states its reason
    'directives/require-reason': 'error',
    'unicorn/no-abusive-eslint-disable': 'error',

    // Parity rules outside `correctness` (measurements, §1 "Kept")
    'array-callback-return': 'error',
    // `== null` stays allowed, as before
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-array-constructor': 'error',
    'no-case-declarations': 'error',
    'no-constructor-return': 'error',
    'no-fallthrough': 'error',
    'no-inner-declarations': 'error',
    'no-prototype-builtins': 'error',
    'no-self-compare': 'error',
    radix: 'error',
    'no-proto': 'error',
    'no-regex-spaces': 'error',
    'no-sequences': 'error',
    'default-case-last': 'error',
    'no-extra-label': 'error',
    'no-labels': 'error',
    'no-label-var': 'error',
    'no-lone-blocks': 'error',
    'no-script-url': 'error',
    'no-template-curly-in-string': 'error',
    'no-useless-computed-key': 'error',
    'prefer-const': 'error',
    'prefer-exponentiation-operator': 'error',
    'prefer-numeric-literals': 'error',
    'prefer-object-has-own': 'error',
    'prefer-regex-literals': 'error',
    'prefer-rest-params': 'error',
    'prefer-template': 'error',
    'no-unneeded-ternary': 'error',
    'no-useless-constructor': 'error',
    // A type import may stand apart from the value import of the same module
    'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
    // A name that starts with `_` is unused on purpose
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      },
    ],
    'typescript/adjacent-overload-signatures': 'error',
    'typescript/ban-ts-comment': 'error',
    'typescript/ban-types': 'error',
    'typescript/consistent-type-exports': 'error',
    'typescript/consistent-type-imports': 'error',
    'typescript/dot-notation': 'error',
    'typescript/no-empty-interface': 'error',
    'typescript/no-empty-object-type': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-extraneous-class': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/prefer-function-type': 'error',
    'typescript/prefer-literal-enum-member': 'error',
    'unicorn/no-document-cookie': 'error',
    'unicorn/no-instanceof-array': 'error',
    'unicorn/no-static-only-class': 'error',
    'unicorn/no-useless-switch-case': 'error',
    'unicorn/prefer-array-flat-map': 'error',
    'unicorn/prefer-array-index-of': 'error',
    'unicorn/prefer-date-now': 'error',
    'unicorn/prefer-dom-node-text-content': 'error',
    'unicorn/prefer-math-min-max': 'error',
    'unicorn/prefer-node-protocol': 'error',
    'unicorn/prefer-number-properties': 'error',
    'oxc/approx-constant': 'error',
    'oxc/misrefactored-assign-op': 'error',
    'oxc/no-const-enum': 'error',

    // Off for good, `tsc` covers what matters
    // A schema and its type share a name (`export const X = Schema.Struct(…)`, `export type X = …`)
    'no-redeclare': 'off',
    // A closure reads a `const` declared after it, which is not a bug; `tsc` reports a real use before declaration
    'no-use-before-define': 'off',
    // It refuses `void` as a type argument (`Deferred.make<void>()`)
    'typescript/no-invalid-void-type': 'off',

    // Off inside `suspicious` and `perf`, wrong for this code
    // `_tag` is Effect's discriminant (and the web tells errors apart by it)
    'no-underscore-dangle': 'off',
    // It misreads the generators of `Effect.gen` and `Effect.fn`
    'typescript/consistent-return': 'off',
    // A helper stays next to the code that reads it (tests, layers, components)
    'unicorn/consistent-function-scoping': 'off',
    // Sweeps, retries and tests are sequential on purpose
    'no-await-in-loop': 'off',
    // `.then` is used for its effect, its value discarded
    'promise/always-return': 'off',
    // A stylesheet is imported for its effect; so is the server bundle by the launcher (`app/bin/llama-webui.ts`)
    'import/no-unassigned-import': ['error', { allow: ['**/*.css', '@llama-webui/theme/*', './server/index.mjs'] }],

    // The general selection (spec, "The selection" › L4)
    // A function of an interface or a type literal is a property, so its parameters are checked strictly (no method
    // bivariance) and reading it off its object is safe (`typescript/unbound-method`)
    'typescript/method-signature-style': 'error',

    // --- Debt: off until its milestone ---
    // Rules on by category or parity rules that report on today's code; the milestone turns each on and fixes
    // its reports. L4: general and type-aware rules; L5: React (the Vitest rules have theirs in oxlint.tests.ts).
    'typescript/no-unsafe-type-assertion': 'off', // L4: 145
    'typescript/no-floating-promises': 'off', // L4: 88
    'no-shadow': 'off', // L4: 40
    'typescript/no-misused-promises': 'off', // L4: 24
    'typescript/no-unnecessary-type-assertion': 'off', // L4: 19
    'typescript/no-base-to-string': 'off', // L4: 17
    'typescript/no-useless-default-assignment': 'off', // L4: 6
    'typescript/prefer-optional-chain': 'off', // L4: 6
    'typescript/restrict-template-expressions': 'off', // L4: 4
    'typescript/switch-exhaustiveness-check': 'off', // L4: 4
    'unicorn/no-new-array': 'off', // L4: 4
    'typescript/no-redundant-type-constituents': 'off', // L4: 3
    'typescript/await-thenable': 'off', // L4: 2
    'typescript/prefer-string-starts-ends-with': 'off', // L4: 2
    'unicorn/new-for-builtins': 'off', // L4: 2
    'oxc/no-accumulating-spread': 'off', // L4: 1
    'prefer-arrow-callback': 'off', // L4: 1
    'promise/no-callback-in-promise': 'off', // L4: 1
    'typescript/no-duplicate-type-constituents': 'off', // L4: 1
    'typescript/no-implied-eval': 'off', // L4: 1
    'typescript/require-array-sort-compare': 'off', // L4: 1
    'unicorn/no-useless-spread': 'off', // L4: 1
    'unicorn/prefer-string-starts-ends-with': 'off', // L4: 1
    'react/immutability': 'off', // L5: 14
    'react/set-state-in-effect': 'off', // L5: 13
    'react/exhaustive-effect-dependencies': 'off', // L5: 6
    'react/hooks': 'off', // L5: 4
    'react/refs': 'off', // L5: 1
    'react/incompatible-library': 'off', // L5: 1
    'react/jsx-no-useless-fragment': 'off', // L5: 1
    'react/no-object-type-as-default-prop': 'off', // L5: 1
    // --- end of debt ---
  },
});

// The root config. `ignorePatterns` do not travel through `extends`, and they are relative to the config that
// declares them: each project config repeats those under its directory.
export default defineConfig({
  extends: [base, tests],
  // What `.gitignore` lists is skipped by oxlint itself. A pattern without a slash matches at any depth: `/docs/`
  // is the design documents, not `site/src/docs`.
  ignorePatterns: [
    // Vendored reference repositories (read-only, never imported); also in `.eslintignore`
    '/repos/',
    '/docs/',
    // shadcn components keep their default code
    '**/src/components/ui',
    '**/testdata',
    // Generated by the contract suite (UPDATE_GOLDEN=1)
    'app/server/contract/golden.json',
    '**/.output',
    'site/build',
    'site/dist',
    'site/.react-router',
    '.claude',
    '.agents',
  ],
});
