# Biome → oxlint and oxfmt: design

Decisions marked **(user)** were taken by the user on 2026-11-22; those marked **(call)** are the author's and can be
overturned. The numbers come from a spike on a throwaway copy of `master` at `7dd1e58b4` (v0.4.2); they are in
`2026-11-22-oxc-migration-measurements.md` (the "appendix"), section by section.

## Intent

Biome 2.6.8 formats, lints and sorts the imports of the whole repository from one `biome.jsonc`, on its `recommended`
preset. The user wants a **stricter lint everywhere** (TypeScript, React, Tailwind, tests), with one configuration at
the root and one per project where a project has rules of its own. Biome is replaced by **oxfmt** (format, order of
imports, of Tailwind classes and of `package.json` keys) and **oxlint** (lint, with the type-aware rules of
`oxlint-tsgolint`).

## Goals

- One formatter and one linter for the repository, both from the oxc project, at exact versions.
- Nothing Biome checks today is lost without being written down and accepted (appendix §1).
- A stricter rule set, chosen rule by rule from what each rule reports on today's code (below), enforced with zero
  warning: an active rule is an error.
- A root configuration, and a configuration per project that extends it: the server (Effect), the web (React,
  Tailwind), the site (React, Tailwind, prerendered), `llamacpp-js` (published, `node:test`).
- The written conventions the linter now enforces leave `CLAUDE.md`, `README.md` and the contributor pages **(user)**.

## Non-goals

- **Accessibility (user).** No hardening: the `jsx-a11y` rules beyond what Biome checks today and the accessibility
  rules of react-doctor are left for later.
- **The Effect diagnostics (user).** They stay in `tsc` (`tsconfig.effect.json` and the `prepare` script unchanged,
  `effect-tsgo patch --typescript --no-oxlint`); oxlint is installed unpatched.
- **CSS lint (user).** The three `.css` files are formatted and no longer linted.
- Markdown is formatted (L2) and not linted. The first decision left `docs/` and every `.md` but `README.md` out;
  Biome formats every `.md` today, so the user brought them all back **(user, after L1)**.
- Refactoring beyond what a retained rule asks for.

## Anti-goals

- **Sorting (user).** No rule and no formatter option that sorts object keys, interface or type members, or JSX
  attributes. The only new sort is the Tailwind class order.
- A rule lowered to `warn`, or switched off, to get a milestone through. A rule that turns out wrong is removed from
  the selection in the PR, with the reason and the reports that show it.
- A suppression without a reason, or a blanket one (a whole file, no rule named).
- A visual change of the app or of the site: none of this retakes a screenshot.

## Constraints

- Every milestone is one PR from `master` **(user)**, green on `pnpm lint`, `pnpm check` (no `effect(` line) and
  `pnpm test`, with the documentation it makes false updated in the same PR.
- `pnpm check`, the tsconfigs and the Effect regime do not change.
- The code style does not change **(call)**: 2 spaces, single quotes (double in JSX), 120 columns, semicolons.
- `repos/` is never read by either tool; `**/src/components/ui` (shadcn), `app/server/contract/golden.json` and
  `testdata` stay out of both, as today.
- A downloaded plugin is a devDependency at an exact version; a version bump is a PR of its own.
- oxlint: the nearest configuration wins and nothing is merged; `options.typeAware` is only read at the root (appendix
  §7).

## Approaches

1. **Tighten Biome.** Turn on its non-recommended rules and its nursery. No migration, but its type-aware rules are a
   handful (six in the `types` domain), it has no Tailwind rule beyond two nursery ones and no plugin for the React
   rules the user asked about. Not what was asked.
2. **ESLint, typescript-eslint and Prettier.** The reference rule set, every plugin exists. Slow on this repository
   (type-aware lint in tens of seconds against 2 s), three tools and a dozen dependencies to keep aligned.
3. **oxlint and oxfmt (user).** 872 native rules including the type-aware ones of typescript-eslint, the rules of the
   React Compiler, JS plugins for the rest; the whole repository in 2.1 s with every rule on. oxfmt is still 0.x, and
   two things are lost (CSS lint, a few Biome rules without an equivalent). **Picked.**

Delivery: all at once, or staged. **Staged (user)**: the formatter first, then the linter at parity (Biome leaves
there), then one hardening per family, so each PR has one kind of diff.

## What the spike settled

- **Format** (appendix §4). With the style above, oxfmt rewrites 27 of 578 files. Import order: 17 files with
  `sortImports: { newlinesBetween: false }`. `package.json` order: 4 files. Tailwind class order: 56 files, 102 lines.
- **MDX** (appendix §4). 32 pages of `site/content/developers` change (tables, JSON of code blocks). Three pages break:
  `<FileTree>` needs a blank line after its opening tag and before its closing tag, written before formatting. With
  it the prerendered HTML is the same, whitespace aside.
- **Parity** (appendix §1). 246 Biome rules are active (217 of the preset, 29 of the domains): 185 have an oxlint
  equivalent, 26 are the CSS lint, 35 are lost or do not apply (GraphQL, rules about Biome itself, syntax errors `tsc`
  reports, and 14 real losses listed under "Losses").
- **Lint** (appendix §2). Every category on: 722 rules, 52,706 reports, 2.1 s. Most is noise by construction
  (`one-var`, `no-magic-numbers`, `sort-keys`…); the selection below is what is worth an error.
- **Mechanics** (appendix §7). Type-aware rules work without a root `tsconfig.json`. Nested TypeScript configs that
  `extends` imported objects work, with JS plugins by package name or by relative path.
- **Effect.** An integration exists (`@effect/tsgo` patches oxlint and ships presets) but pins oxlint and tsgolint to
  the versions it supports; not used.

## Design

### Files

```
oxfmt.config.ts                         format of the whole repository
oxlint.config.ts                        the base: plugins, categories, type-aware, the general selection;
                                        applies as is to scripts/, app/build, app/bin and the root files
oxlint.react.ts                         shared fragment: React rules (imported by app/src and site)
oxlint.tests.ts                         shared fragment: Vitest rules for *.test.ts(x)
scripts/oxlint/directives.ts            local plugin: a suppression states its reason (typed and tested with scripts/)
app/server/oxlint.config.ts             base + tests; require-yield off; no-console on; server import bans
app/src/oxlint.config.ts                base + react + tests; Tailwind (index.css); no-console on; web import bans
site/oxlint.config.ts                   base + react + tests; Tailwind (src/styles/app.css); site import bans
packages/llamacpp-js/oxlint.config.ts   base; no Vitest (node:test); package import bans
packages/webui-shared/oxlint.config.ts  base + tests (only if it needs a rule of its own, otherwise the root applies)
```

A project config is `defineConfig({ extends: [base, …fragments], … })` with the base imported from the root file
**(call)**. Each rule that is off or configured carries a one-line comment with its reason, in the config: that is
where the reason lives, not in `CLAUDE.md`.

### Formatter

`oxfmt.config.ts`: `printWidth: 120`, `singleQuote: true` (with an override that keeps double quotes in `.css` and
`.yaml`/`.yml`), `sortImports: { newlinesBetween: false }`, `sortPackageJson: true`, and from L6
`sortTailwindcss: { functions: ['cn', 'cva'] }` with one override per project for its stylesheet (`app/**` →
`app/src/index.css`, `site/**` → `site/src/styles/app.css`). Scope: TS, TSX, JSON, CSS, YAML, then (L2) the MDX of
`site/content` and every `.md`, `docs/` included. Ignored: what `biome.jsonc` ignores (its `files.includes` exclusions and, through `vcs.useIgnoreFile`, everything in
`.gitignore`), plus `pnpm-lock.yaml`. The same holds for oxlint.

The import and `package.json` orders are kept because Biome already applies both **(user)**. Fenced code blocks in
MDX are left as written (`embeddedLanguageFormatting: 'off'` for `*.mdx`) **(user)**: the hand-written API reference keeps its JSON examples as their author laid them out, and the
MDX diff drops to the tables.

### Linter

Root `oxlint.config.ts`: plugins `eslint`, `typescript`, `unicorn`, `oxc`, `import`, `promise`;
`options.typeAware: true`; categories `correctness`, `suspicious` and `perf` in `error` (from L3 for the first, L4 for
the other two); then the retained rules of the other categories one by one. `react`, `jsx-a11y` (parity only) and
`vitest` come from the fragments, so a server file is never read as React (`Published.use(…)` is not a hook) and
`llamacpp-js` tests are never read as Vitest.

Commands **(call)**: `lint` = `oxfmt --check && oxlint --deny-warnings --report-unused-disable-directives`,
`lint:fix` = `oxlint --fix && oxfmt`, `format` = `oxfmt`. `oxlint --fix` applies safe fixes only; a milestone may use
`--fix-suggestions` once and review the diff.

### Suppressions

`// oxlint-disable-next-line <rule> -- <reason>`: the rule named (`unicorn/no-abusive-eslint-disable`), the reason
required (`directives/require-reason`, the local plugin, ten lines, tried in the spike), an unused directive reported.
The 30 `biome-ignore` (22 files) become such directives with their reason at L3, except the three in `.css` files, which go with the CSS lint, and the two of `noComponentHookFactories`, a rule oxlint does not have.

### Tailwind (L6)

`oxlint-tailwindcss` 1.17.2 (MIT) as a JS plugin in `app/src` and `site`, each with its `entryPoint`. Rules on: its
recommended set minus `enforce-sort-order` and `enforce-consistent-line-wrapping` (oxfmt owns order and wrapping: the
two disagree on 4 places) and with `aurora` and the other classes of `@llama-webui/theme` allowed by name in
`no-unknown-classes`. 34 reports today, 2 in the web and 32 in the site (appendix §5).

A report is fixed only by an equivalent form **(call)**: a shorthand, a canonical spelling, a hex colour replaced by
the theme token of exactly that value. A colour without such a token keeps its value under a suppression with its
reason (the landing page reproduces screens of the app with their real colours); no token is added to the theme and
no colour changes.

### react-doctor (L5, licence accepted by the user)

`oxlint-plugin-react-doctor` 0.9.23, the plugin alone, in the React fragment, with **ten rules** and nothing else of
its 907 (appendix §6): `no-mirror-prop-effect`, `no-reset-all-state-on-prop-change`,
`no-set-state-after-await-in-effect`, `no-loading-flag-reset-outside-finally`, `no-impure-state-updater`,
`zustand-no-whole-store-destructure`, `no-enter-submit-without-ime-composition-guard`,
`react-router-require-root-error-boundary`, `rerender-state-only-in-handlers`, and for the site only (it prerenders)
`no-unguarded-browser-global-in-render-or-hook-init`. 12 reports, each read and right. It costs 1.8 s per run and a
dependency under a non-standard licence; without it L5 keeps the native React rules, which already report the two
`useEffect(() => setX(prop), [prop])`.

### CI and editor

The lint job keeps one step (`pnpm lint`): about 2 s of native rules, 6 s for the Tailwind plugin and 2 s for
react-doctor on 12 threads, to be read again on the 4-core runner at L3 and L6; no job of its own unless it passes a
minute. `.vscode/` is git-ignored: the contributor pages name the `oxc.oxc-vscode` extension and its two settings (formatter at
L1, fix-on-save at L3), each contributor switches their own file.

## The selection

Counts are reports on today's code, default options unless said; "tests" is the share in test files. A milestone
turns a rule on, fixes its reports (or suppresses one with a reason) and leaves it in `error`.

### L3: parity, no code change

The category `correctness`, plus the Biome equivalents that live in other categories (appendix §1, "Kept"), with the
options that make them match Biome (appendix §3): `eqeqeq` with `null: 'ignore'`, `no-unused-vars` with `^_`,
`vitest/no-standalone-expect` knowing `it.effect` and `it.live`, `vitest/valid-expect` with `maxArgs: 2`,
`require-yield` off in `app/server`, `react/react-in-jsx-scope` off. `jsx-a11y` is on with **the Biome equivalents
that pass today and nothing else (call)**: every other rule of the plugin is switched off by name, the category would
otherwise turn it on (two of the five `jsx-a11y` rules that report today are not Biome's).

Every other rule of `correctness`, or Biome equivalent, that reports on today's code goes into **one marked block of
the root config, off, with its count and the milestone that turns it on** (L4 or L5). L4 and L5 empty that block; L7
checks it is gone. This is what keeps L3 free of code changes.

Three equivalents stay off for good, `tsc` covering what matters: `no-redeclare` (117: a schema and its type share a
name), `no-use-before-define` (41 with options: closures over a later `const`), `typescript/no-invalid-void-type` (21:
it refuses `Deferred.make<void>()`).

### L4: general and type-aware

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reports | Note                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/method-signature-style`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |     148 | no autofix in oxlint 1.94, mechanical (112 web, 31 server, 5 site): a method of an interface becomes a property, which clears the next one for the store actions |
| `typescript/unbound-method`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |      82 | all in the web (`(s) => s.toggle`)                                                                                                                               |
| `typescript/no-unsafe-type-assertion`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |      64 | 136 with tests: **off in test files**; the largest item, a commit of its own                                                                                     |
| `typescript/no-unsafe-assignment`, `-member-access`, `-argument`, `-return`, `-call`                                                                                                                                                                                                                                                                                                                                                                                                           |      43 |                                                                                                                                                                  |
| `typescript/no-unnecessary-condition`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |      41 | nursery: dropped if it misfires                                                                                                                                  |
| `no-shadow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |      40 | 22 in tests                                                                                                                                                      |
| `unicorn/no-array-sort`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |      29 | `toSorted()`                                                                                                                                                     |
| `typescript/no-misused-promises`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |      23 | stricter than Biome's                                                                                                                                            |
| `typescript/no-unnecessary-type-assertion`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |      19 | safe autofix                                                                                                                                                     |
| `typescript/no-base-to-string`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |      16 |                                                                                                                                                                  |
| `typescript/no-confusing-void-expression`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |      15 | with `ignoreArrowShorthand`, `ignoreVoidOperator` (269 without)                                                                                                  |
| `no-implicit-coercion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |      15 |                                                                                                                                                                  |
| `unicorn/prefer-string-replace-all`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |      13 |                                                                                                                                                                  |
| `typescript/prefer-nullish-coalescing`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |      12 |                                                                                                                                                                  |
| `typescript/use-unknown-in-catch-callback-variable`                                                                                                                                                                                                                                                                                                                                                                                                                                            |       8 |                                                                                                                                                                  |
| `typescript/no-floating-promises`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |       7 | with `node:test` known safe (88 without)                                                                                                                         |
| `typescript/prefer-includes`, `unicorn/prefer-add-event-listener`                                                                                                                                                                                                                                                                                                                                                                                                                              |   7 + 7 |                                                                                                                                                                  |
| `typescript/no-useless-default-assignment`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |       6 | read the six first: off if it misreads `noUncheckedIndexedAccess`                                                                                                |
| `typescript/prefer-optional-chain`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |       6 | nursery                                                                                                                                                          |
| `no-console`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |       4 | `app/src` and `app/server` only; scripts print by design                                                                                                         |
| The rest of `correctness`, `suspicious` and `perf`, and `typescript/switch-exhaustiveness-check`, `require-await`, `restrict-plus-operands`, `restrict-template-expressions`, `prefer-promise-reject-errors`, `no-deprecated`, `consistent-type-definitions`, `prefer-readonly`, `prefer-regexp-exec`, `unicorn/prefer-at`, `prefer-set-has`, `no-new-array`, `oxc/no-map-spread`, `import/no-unassigned-import` (CSS imports allowed), `no-duplicate-imports` (separate type imports allowed) |    ≈ 60 | 1 to 5 each                                                                                                                                                      |

About 680 reports, about 70 of them with a safe autofix. Off inside the three categories, with the reason in the config:
`no-underscore-dangle` (140: `_tag`), `typescript/consistent-return` (62: it misreads `Effect.gen` generators),
`unicorn/consistent-function-scoping` (53), `no-await-in-loop` (77: sweeps, retries and tests are sequential on
purpose), `promise/always-return` (11: `.then` used for its effect).

### L5: React and tests

| Rule                                                                                                                                       | Reports | Note                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------: | ------------------------------------------------------ |
| `react/immutability`                                                                                                                       |      14 | all in `topology/TopologyScene.tsx` (the render pacer) |
| `react/set-state-in-effect`                                                                                                                |      13 | 11 web, 2 site                                         |
| `react/no-array-index-key`                                                                                                                 |       8 | already Biome's, 10 directives today                   |
| `react/no-unescaped-entities`                                                                                                              |       6 |                                                        |
| `react/refs`                                                                                                                               |       2 |                                                        |
| `react/no-object-type-as-default-prop`, `react/incompatible-library`, `react/memo-dependencies`                                            |       3 |                                                        |
| `vitest/no-conditional-expect`, `require-mock-type-parameters`, `require-to-throw-message`, `prefer-to-have-length`, `prefer-called-times` |       9 |                                                        |
| react-doctor, ten rules                                                                                                                    |      12 |                                                        |

Off: `react/hooks` (5: it reads `useMonitor.getState()` of Zustand as a hook used as a value),
`react/exhaustive-effect-dependencies` (9: the same check as `react-hooks/exhaustive-deps`, which stays).
**Changed during L5 (user decision):** both are on in `error` instead, their reports fixed (selectors for `react/hooks`)
and each deliberate trigger dependency suppressed with its reason (6). Not
enabled: the `react-perf` plugin (449 reports: every inline handler, which only matters under `memo`) and
`react/no-unknown-property` (49: the three.js elements of react-three-fiber).

### L7: architecture

`no-restricted-imports` per project and `import/no-cycle` (0 report today):

| Project                 | May not import                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src`               | `app/server/**`, `node:*`, `repos/**`                                                                                                        |
| `site`                  | anything of `app/`, `repos/**`                                                                                                               |
| `packages/llamacpp-js`  | `@llama-webui/*`; `node:*` outside its `node` entry                                                                                          |
| `packages/webui-shared` | `app/**`, `node:*`                                                                                                                           |
| `app/server`            | `better-sqlite3`, `bun:*`, `repos/**` (`node:*`, `node:child_process` included, is already the Effect diagnostics' business and stays there) |

The `node:*` bans are for source files **(call)**: test files and `app/server/testing/**` are exempt (the black-box
suites and three tests of `webui-shared` use `node:*` on purpose, and `llamacpp-js` tests run on `node:test`). The
other bans apply to tests too. L7 changes no code: a ban that reports today is a ban written wrong.

The tests that check the same things on the build (`app/server/build.test.ts`, `scripts/package.test.ts`,
`packages/llamacpp-js/tests/package.test.ts`) stay: they check the output, the rules check the source.

### Declined

Sorting rules (`sort-keys` 2,797, `sort-imports`, `react/jsx-sort-props`, member ordering) **(user)**. Bans of a
language feature (`no-ternary`, `no-null`, `no-undefined`, `no-optional-chaining`, `no-async-await`, `no-plusplus`,
`no-void`, `no-continue`, `no-bitwise`). Size limits (`max-lines`, `max-lines-per-function`, `max-statements`,
`max-params`, `complexity`, `react/jsx-max-depth`, `import/max-dependencies`). Naming and layout (`id-length`,
`func-style`, `func-names`, `new-cap`, `filename-case`, `capitalized-comments`, `one-var`, the `import/*` export-style
rules, `unicorn/catch-error-name`). Rules that misread this code: `unicorn/throw-new-error` (`Schema.TaggedError<…>()(…)`),
`typescript/array-type` (502: Effect code writes `ReadonlyArray<T>`), `no-undef` (481: `tsc` does it).

Five strict rules were offered to the user and **declined (user)**, each a large diff:

| Rule                                    | Reports | What it would ask                                      |
| --------------------------------------- | ------: | ------------------------------------------------------ |
| `curly`                                 |   1,315 | braces on every `if`/`for` body (autofix)              |
| `typescript/strict-boolean-expressions` |     233 | no truthiness test on a string, a number or a nullable |
| `typescript/no-non-null-assertion`      |     226 | no `!`; off under Biome today, by choice               |
| `vitest/prefer-strict-equal`            |     323 | `toStrictEqual` instead of `toEqual`                   |
| `no-nested-ternary`                     |      89 | mostly JSX                                             |

## Losses

Accepted with this design, all from appendix §1:

- **CSS lint**: 26 rules on three files (and the three `noImportantStyles` suppressions).
- **No oxlint rule**: `noThisInStatic`, `noUselessContinue`, `noUselessStringRaw`, `noFlatMapIdentity`,
  `noUselessUndefinedInitialization`, `useSimpleNumberKeys`, `noStringCaseMismatch`,
  `noDynamicNamespaceImportAccess`, `noSuspiciousSemicolonInJsx`, `noImplicitAnyLet` (in part `tsc`),
  `noSvgWithoutTitle`, `noComponentHookFactories` (two suppressions today, in `app/src/app/router.tsx`),
  `noPrivateImports` (no `@private` in the repository).
- **Off for good**: `no-redeclare`, `no-use-before-define`, `no-invalid-void-type` (above), and four `jsx-a11y` rules
  that report today: two Biome equivalents whose oxlint version is stricter (`prefer-tag-over-role`, `no-autofocus`)
  and two rules Biome does not have. `no-noninteractive-tabindex` stays on, its one report under a converted
  directive.
- **Needs another plugin**: `noExportsInTest` (`jest/no-export` runs only under the `jest` plugin, which is not
  enabled).
- **`packages/llamacpp-js` tests**: they run on `node:test`, so no Vitest rule applies there and they lose Biome's
  three test checks (focused tests, duplicate hooks, identical titles).

## Milestones

Each is one PR; "docs" names what it rewrites. A milestone too large to review is split by project when its plan is
written. They run in order, on stacked branches **(user, after L1)**: a milestone branches from the previous one and its PR is
based on that branch; the user merges the PRs one by one at the end (`master` is protected, squash). The squash
commits of the formatting PRs exist only then: `.git-blame-ignore-revs` is one small PR after the last merge.

|        | What                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done when                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L0** | This document, the appendix, and the plan of each milestone (`docs/superpowers/plans/`).                                                                                                                                                                                                                                                                                                                                                           | The user approves the selection and the losses.                                                                                                                                |
| **L1** | oxfmt formats TS, TSX, JSON, CSS and YAML; Biome's formatter and import sorting are off and Biome only lints (`lint` = `oxfmt --check && biome lint`). Three commits: the config, the raw output, the hand edits (a `biome-ignore` moved by the reformat). PRs are squashed: the squash commit of a formatting PR goes into `.git-blame-ignore-revs` in the PR of the next milestone. Editor formatter. Docs: the format half of "Format et lint". | `oxfmt --check` clean; the diff is the 27 + 17 + 4 files of the spike, or the difference is explained.                                                                         |
| **L2** | A blank line inside the three `<FileTree>`, the table row of `api/bench.mdx:46`, then oxfmt on `site/content/**/*.mdx` and every `.md` (raw output in its own commit). Docs: "Biome ignore les `.mdx`".                                                                                                                                                                                                                                            | The prerendered HTML of the 61 pages is the same before and after, whitespace aside; `check-links` passes.                                                                     |
| **L3** | oxlint at parity (above); the configs of "Files" except the Tailwind and architecture parts; `scripts/oxlint/directives.ts`; the `biome-ignore` converted; `@biomejs/biome` and `biome.jsonc` removed; final scripts; editor; the comment of `ci.yml`. Docs: "Format et lint" of `CLAUDE.md`, `conventions.mdx`, `README.md` and the five other developer pages that name Biome.                                                                   | No source line changes except directives. `oxlint --print-config` on one file per project shows that project's rules, and one planted violation per project fails `pnpm lint`. |
| **L4** | The L4 table, one commit per rule or family (the rule on, then its fixes).                                                                                                                                                                                                                                                                                                                                                                         | The L4 part of the marked block is empty.                                                                                                                                      |
| **L5** | The L5 table, react-doctor included.                                                                                                                                                                                                                                                                                                                                                                                                               | The marked block is gone.                                                                                                                                                      |
| **L6** | `sortTailwindcss` in oxfmt (raw output in its own commit) and `oxlint-tailwindcss`; its reports fixed.                                                                                                                                                                                                                                                                                                                                             | No visual change: the classes changed are equivalent forms (`inset-y-2.5`), checked by eye on the pages touched.                                                               |
| **L7** | The L7 table; last pass on `CLAUDE.md`, `README.md` and the site pages; the row of "Keep the docs in sync" in `workflow.mdx`.                                                                                                                                                                                                                                                                                                                      | One planted import per ban fails `pnpm lint`. The user approves.                                                                                                               |

At every milestone: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build` then `node scripts/smoke.ts`,
`pnpm site:build` then `pnpm --dir site check-links`, CI green.

## What leaves the written conventions

The milestone that turns the rule on replaces the passage by the rule's name, or drops it. What no rule checks stays
written.

| Passage (`CLAUDE.md`, mirrored in `conventions.mdx` and `README.md`)                                                                                                                                        | Carried by                                                                  | At  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --- |
| The style paragraph of "Format et lint" (indent, quotes, width, semicolons)                                                                                                                                 | `oxfmt.config.ts`                                                           | L1  |
| "Biome ne détecte pas React depuis une version `catalog:`…"                                                                                                                                                 | no longer true                                                              | L3  |
| "`correctness/useYield` est coupée pour `app/server/**`"                                                                                                                                                    | the comment in `app/server/oxlint.config.ts`                                | L3  |
| "Ne pas désactiver une règle… `biome-ignore` ciblé et motivé"                                                                                                                                               | `directives/require-reason`, `no-abusive-eslint-disable`, unused directives | L3  |
| "Une correction `--unsafe` d'imports inutilisés emporte le commentaire…"                                                                                                                                    | Biome-specific; checked once against `oxlint --fix`                         | L3  |
| "Biome ignore les `.mdx`"                                                                                                                                                                                   | oxfmt formats them                                                          | L2  |
| "toujours `await expect(…).rejects`"                                                                                                                                                                        | `vitest/valid-expect`, `typescript/no-floating-promises`                    | L4  |
| "pour réinitialiser un état au changement d'identité, un `key`… plutôt qu'un effet"                                                                                                                         | `react/set-state-in-effect` (and `no-reset-all-state-on-prop-change`)       | L5  |
| "Le web n'importe rien de `app/server/`", "[le site] n'importe aucun code de `app/`", "Aucune dépendance ni import de `@llama-webui/*`", "Do not import from repos/", "Ni `bun:sqlite` ni `better-sqlite3`" | `no-restricted-imports`                                                     | L7  |
| `import type` in `llamacpp-js`                                                                                                                                                                              | `typescript/consistent-type-imports`                                        | L3  |

Stay written: `useEffectEvent` rather than a suppression, "jamais de `fetch('/api…')`" and "jamais de cast sur une
réponse" (no rule expresses them exactly), the locale and `_tag` rules, everything about Effect.

## Risks

- **oxfmt is 0.x**: a bump may reformat. Exact version, bump alone, its commit in `.git-blame-ignore-revs`.
- **Two third-party JS plugins** (Tailwind, react-doctor): slower than native rules and tied to oxlint's plugin API,
  itself young. Each is confined to one milestone and one fragment; removing one is deleting its block.
- **A nursery rule** (`no-unnecessary-condition`, `prefer-optional-chain`) may change behaviour on a bump.
- **L4 is large** (about 680 reports). It is the milestone most likely to be split, by family: the method-signature
  pair, the unsafe family, the rest.

## Decided after the spike (user, 2026-11-22)

The user accepted the calls of this document and settled the five decisions it left open:

1. **Import and `package.json` order**: kept, as Biome does it today.
2. **react-doctor**: in, licence accepted, with the ten rules above.
3. **Accessibility**: the `jsx-a11y` equivalents of Biome's rules that pass today stay on as a safety net.
4. **Code blocks in MDX**: left as written.
5. **The five strict rules** of "Declined" (`curly`, `strict-boolean-expressions`, `no-non-null-assertion`,
   `vitest/prefer-strict-equal`, `no-nested-ternary`): out.

After L1 (same day) the user settled three more:

6. **Markdown**: every `.md` is formatted by oxfmt from L2 on, `docs/` and `CLAUDE.md` included, as Biome did.
7. **Sequencing**: stacked branches, each PR based on the previous branch, merged one by one at the end.
8. **Editor**: the local `.vscode/settings.json` formats with `oxc.oxc-vscode` from L1 on, lints with it from L3 on.

Plans: `docs/superpowers/plans/2026-11-22-oxc-l1-oxfmt.md` to `…-oxc-l7-architecture.md`, one per milestone.

## Left to the builder

- The exact option objects of each rule, the glob of test files, the order of commits inside a milestone.
- Whether `packages/webui-shared` needs its own config.
- How the theme's class names reach `no-unknown-classes` (a list in the config, or the plugin's own setting).
- The wording of the rewritten documentation.
- Whether oxfmt and oxlint skip what `.gitignore` lists by themselves, or need the entries written (L1, L3).
- Whether `jest/no-export` runs under the `vitest` plugin (L3), and whether every linted file belongs to a
  `tsconfig.json` tsgolint finds (`app/bin`, the root config files).
