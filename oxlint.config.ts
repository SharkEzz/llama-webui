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
  // An unused suppression is also shown in the editor; `pnpm lint` fails on it (`--report-unused-disable-directives`
  // with `--deny-warnings`)
  options: { typeAware: true, reportUnusedDisableDirectives: 'warn' },
  settings: {
    // The React version the `react/*` rules check against: the `react` of the catalog (`pnpm-workspace.yaml`)
    react: {
      version: '19.3.1',
    },
    // Typecheck mode of the Vitest rules: some skip their checks on `describe` blocks that hold type tests
    vitest: {
      typecheck: true,
    },
  },
  // The vendored repositories are reference material, not linted (`.eslintignore` keeps oxlint from loading their
  // configs)
  ignorePatterns: ['repos/**'],
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

    // Options inside `suspicious` and `perf`
    // A stylesheet is imported for its effect; so is the server bundle by the launcher (`app/bin/llama-webui.ts`)
    'import/no-unassigned-import': ['error', { allow: ['**/*.css', '@llama-webui/theme/*', './server/index.mjs'] }],

    // The general selection (spec, "The selection" › L4)
    // A function of an interface or a type literal is a property, so its parameters are checked strictly (no method
    // bivariance) and reading it off its object is safe (`typescript/unbound-method`)
    'typescript/method-signature-style': 'error',
    // No `any` flows from `JSON.parse`, a catch variable or an untyped import: decode it or give it a type
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-return': 'error',
    'typescript/no-unsafe-call': 'error',
    // A cast is a decode, a guard, a `satisfies` or a narrower declaration (off in tests, see `overrides`)
    'typescript/no-unsafe-type-assertion': 'error',
    'typescript/use-unknown-in-catch-callback-variable': 'error',
    'typescript/no-base-to-string': 'error',
    // A promise is awaited, returned, handled or discarded on purpose (`void`); the test functions of `node:test`
    // (llamacpp-js) return a promise the runner handles
    'typescript/no-floating-promises': [
      'error',
      {
        allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe', 'suite'], package: 'node:test' }],
      },
    ],
    // A function that returns a promise is not passed where a `void` callback is expected (an event handler)
    'typescript/no-misused-promises': 'error',
    // A `void` value is not used as a value; `() => f()` and `void f()` say the result is discarded
    'typescript/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true, ignoreVoidOperator: true }],
    // An `async` function awaits something (the check without types, `require-await`, is replaced by this one)
    'require-await': 'off',
    'typescript/require-await': 'error',
    'typescript/prefer-promise-reject-errors': 'error',
    'typescript/await-thenable': 'error',
    // A condition the types already decide is removed; a guard on data from outside the types stays, its type
    // fixed or its line suppressed with the reason. `while (true)` is a loop that ends by `return` or `break`
    'typescript/no-unnecessary-condition': ['error', { allowConstantLoopConditions: 'only-allowed-literals' }],
    'typescript/prefer-optional-chain': 'error',
    // `||` on a string, a number or a boolean falls back on `''`, `0` and `false` on purpose (an empty name shows
    // its placeholder, `0` is refused): the rule asks for `??` on objects only
    'typescript/prefer-nullish-coalescing': ['error', { ignorePrimitives: true }],
    // A `default` stands for the rest of the union on purpose
    'typescript/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    'typescript/no-unnecessary-type-assertion': 'error',
    'typescript/no-useless-default-assignment': 'error',
    'typescript/no-redundant-type-constituents': 'error',
    'typescript/no-duplicate-type-constituents': 'error',
    // A name declared in an inner scope does not hide one of an outer scope: the inner one is renamed. The `it` of
    // `layer(L)('…', (it) => …)` (@effect/vitest) hides the module's `it` on purpose: the Vitest rules know a test
    // block by that name (`vitest/no-standalone-expect` reads `it.effect`, `vitest/no-identical-title` an `it` call)
    'no-shadow': ['error', { allow: ['it'] }],
    // `Boolean(x)`, `Number(x)` and `String(x)` say the conversion that `!!x`, `+x` and `'' + x` hide
    'no-implicit-coercion': 'error',
    'unicorn/prefer-string-replace-all': 'error',
    'typescript/prefer-includes': 'error',
    'unicorn/prefer-at': 'error',
    'unicorn/no-new-array': 'error',
    'unicorn/new-for-builtins': 'error',
    // A template or a `+` joins strings and numbers only: anything else is converted by name (`String(x)`)
    'typescript/restrict-template-expressions': 'error',
    'typescript/restrict-plus-operands': 'error',
    'typescript/consistent-type-definitions': 'error',
    'typescript/prefer-readonly': 'error',
    'typescript/prefer-regexp-exec': 'error',
    // `document.execCommand('copy')` is the copy of a page outside a secure context (opened by a LAN IP), which has
    // no `navigator.clipboard` (`app/src/lib/clipboard.ts`)
    'typescript/no-deprecated': ['error', { allow: [{ from: 'lib', name: 'execCommand' }] }],
    'typescript/prefer-string-starts-ends-with': 'error',
    'unicorn/prefer-string-starts-ends-with': 'error',
    // A named function passed to `memo` names its component (React's DevTools, error stacks)
    'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
    // A parameter of a generator passed to `Effect.fn` is typed by `Effect.fn`'s `any` arguments, not by its default:
    // `function* (size: number = 4000)` (`downloads/transfer.test.ts`) or `(sysBlockRoot: string = '/sys/block')`
    // (`collectors/disk.ts`) would be `any` without their annotation
    'typescript/no-inferrable-types': ['error', { ignoreParameters: true }],
    'oxc/no-accumulating-spread': 'error',
    // The dev server's middleware calls connect's `next` once the server answers: it waits for it on purpose
    // (`app/build/devServer.ts`)
    'promise/no-callback-in-promise': ['error', { exceptions: ['next'] }],
    'typescript/no-implied-eval': 'error',
    'typescript/require-array-sort-compare': 'error',
    'unicorn/no-useless-spread': 'error',
  },
  overrides: [
    {
      // A test casts its fixtures and its stubs to the type under test (the server's `testing/` too: its own
      // config, since a glob is relative to the config that uses it)
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: { 'typescript/no-unsafe-type-assertion': 'off' },
    },
  ],
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
