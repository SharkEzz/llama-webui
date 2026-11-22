# oxc migration, L3: oxlint at parity, Biome removed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** oxlint checks what Biome checks today, with the root config and the per-project configs in place, and Biome
leaves the repository. No source line changes except suppression comments.

**Architecture:** A root `oxlint.config.ts` (base), two shared fragments (`oxlint.react.ts`, `oxlint.tests.ts`), one
config per project that `extends` them, a local plugin for suppression reasons. Every rule that would need a code
change sits in one marked block, off, for L4 and L5 to empty.

**Tech Stack:** oxlint 1.94.0, oxlint-tsgolint 7.0.2008 (both exact), oxfmt 0.79.0.

**Spec:** `docs/superpowers/specs/2026-11-22-oxc-migration-design.md` ("Linter", "Suppressions", "The selection" › L3,
"Losses") and appendix §1 (parity table), §3 (options), §7 (mechanics).

## Global Constraints

- Branch `chore/oxlint` from `chore/oxfmt-mdx` (stacked; the PR is based on it); one PR; green on `pnpm lint`, `pnpm check`
  (0 `effect(` line), `pnpm test`.
- **No code change**: `git diff master --stat -- '*.ts' '*.tsx' '*.css'` outside the new config files shows only
  comment lines (directives converted or removed).
- Every active rule is `error`. `pnpm lint` = `oxfmt --check && oxlint --deny-warnings --report-unused-disable-directives`.
- A rule that is off or has options carries a one-line comment with its reason, in the config.
- The Effect diagnostics stay in `tsc`: `prepare` keeps `effect-tsgo patch --typescript --no-oxlint`,
  `tsconfig.effect.json` untouched.
- Accessibility: only the `jsx-a11y` equivalents of Biome's rules that pass today are on; every other rule of the
  plugin is off by name.
- No sorting rule of any kind.
- Never linted: `repos/`, `**/src/components/ui`, `app/server/contract/golden.json`, `**/testdata`, `docs/`, build
  outputs, what `.gitignore` lists. `ignorePatterns` are relative to the config file that declares them, and a nested
  config does not inherit the root's: each project config repeats the ones under it.

## Review Focus

- A project config that silently does not apply (wrong file name, a parse error swallowed, `extends` missing): the
  root rules run instead and nobody notices. Task 5 plants one violation per project and reads `--print-config`.
- A nested config drops what the root ignored: shadcn `src/components/ui` linted in `app/src` or `site`. Task 5
  checks a file of each ignored tree is reported as ignored.
- A converted directive that silences nothing (the oxlint rule reports on another line or under another name): caught
  by `--report-unused-disable-directives`; and the converse, a Biome suppression dropped whose oxlint rule does report.
- A file outside every `tsconfig.json` (root config files, `app/bin`) makes a type-aware rule fail or go quiet: Task 2
  reads the output for configuration errors.
- `pnpm lint` succeeding while oxlint printed warnings: `--deny-warnings` in the script, checked in Task 5.

---

### Task 1: The suppression-reason plugin

**Files:**

- Create: `scripts/oxlint/directives.ts` (`.js` with JSDoc types if oxlint cannot load a `.ts` plugin: try `.ts` first)
- Test: `scripts/oxlint/directives.test.ts` (Vitest project `server`, which already covers `scripts/`)

**Interfaces:**

- Produces: plugin name `directives`, rule `directives/require-reason`, default export
  `{ meta: { name: 'directives' }, rules: { 'require-reason': Rule } }`. Loaded by `jsPlugins: ['<relative path>']`.

- [ ] **Step 1:** `pnpm add -D -w -E oxlint@1.94.0 oxlint-tsgolint@7.0.2008`.
- [ ] **Step 2:** Write the failing test. It writes four files and an `.oxlintrc.json` (`jsPlugins` pointing at the
      plugin by absolute path, `rules: { 'directives/require-reason': 'error', 'no-console': 'error' }`) into a temporary
      directory, runs `node_modules/.bin/oxlint -f json <dir>` and asserts on the `directives(require-reason)` diagnostics:
  - `// oxlint-disable-next-line no-console` → 1 report on that line
  - `// oxlint-disable-next-line no-console -- the CLI prints its version` → 0
  - `/* oxlint-disable no-console */` → 1; `/* eslint-disable-next-line no-console -- why */` → 0
  - `// oxlint-disable-line no-console --` (nothing after the dashes) → 1
    The message is `A suppression states its reason: \`-- <reason>\`.`
- [ ] **Step 3:** Run it: `pnpm exec vitest run scripts/oxlint/directives.test.ts`. Expected: FAIL (no plugin).
- [ ] **Step 4:** Implement the rule: on `Program`, for each comment of `context.sourceCode.getAllComments()` whose
      trimmed text starts with `oxlint-disable` or `eslint-disable` (any suffix; not `-enable`), report at the comment's
      `loc` unless the text contains `--` followed by a non-space character.
- [ ] **Step 5:** Run the test. Expected: PASS. Commit: `chore: add oxlint and the suppression-reason rule`.

### Task 2: The root config and the fragments

**Files:**

- Create: `oxlint.config.ts`, `oxlint.react.ts`, `oxlint.tests.ts`

**Interfaces:**

- Produces: `oxlint.config.ts` default-exports the base (`defineConfig`), usable both as the root config and in
  `extends`; `oxlint.react.ts` exports `react`, `oxlint.tests.ts` exports `tests` (each an `OxlintConfig` object).
  `tests` applies its rules through `overrides` on `**/*.test.ts` and `**/*.test.tsx`.

- [ ] **Step 1:** Base: plugins `eslint`, `typescript`, `unicorn`, `oxc`, `import`, `promise`;
      `options: { typeAware: true }`; `categories: { correctness: 'error' }`; `jsPlugins` with the directives plugin;
      `directives/require-reason` and `unicorn/no-abusive-eslint-disable` on; `ignorePatterns` as in the constraints.
- [ ] **Step 2:** Add, by name, every rule of appendix §1 "Kept" whose category is not `correctness` (they are not on
      by category), with the options of appendix §3: `eqeqeq: ['error', 'always', { null: 'ignore' }]`,
      `no-unused-vars` ignoring names that start with `_` (arguments, variables, caught errors, destructured array
      elements), `no-duplicate-imports` with `allowSeparateTypeImports`. The React ones go to `oxlint.react.ts` (plugins
      `react`, `jsx-a11y`; `react/react-in-jsx-scope` off), the test ones to `oxlint.tests.ts` (plugin `vitest`;
      `vitest/no-standalone-expect` with `additionalTestBlockFunctions: ['it.effect', 'it.live', 'it.scoped', 'it.scopedLive']`,
      `vitest/valid-expect` with `maxArgs: 2`).
- [ ] **Step 3:** Off for good, each with its reason (spec, "L3"): `no-redeclare`, `no-use-before-define`,
      `typescript/no-invalid-void-type`.
- [ ] **Step 4:** Run `pnpm exec oxlint -f json . > <scratch>/l3.json` with only these three files (no project config
      yet). Read stderr for configuration errors ("file is not part of a project" and the like): a root file or `app/bin`
      outside every `tsconfig.json` is settled here (add it to the closest project's `include`, or exclude it from the
      type-aware rules with an override), and the choice written as a comment.
- [ ] **Step 5:** Group the remaining diagnostics by rule. Each rule that reports goes into **one block of the base,
      delimited by `// --- Debt: off until its milestone ---` and `// --- end of debt ---`**, as
      `'<rule>': 'off', // L4: <count>` or `// L5: <count>` (L5 for `react/*`, `react-hooks/*`, `vitest/*`; L4 for the
      rest). The rules of `jsx-a11y` that report are not debt: they go off in `oxlint.react.ts` with the reason
      "accessibility is out of scope for now", along with every `jsx-a11y` rule that is not a Biome equivalent.
- [ ] **Step 6:** Commit: `chore: oxlint base config at parity with Biome`.

### Task 3: The project configs

**Files:**

- Create: `app/server/oxlint.config.ts`, `app/src/oxlint.config.ts`, `site/oxlint.config.ts`,
  `packages/llamacpp-js/oxlint.config.ts`; `packages/webui-shared/oxlint.config.ts` only if it needs a rule of its own

- [ ] **Step 1:** Each is `defineConfig({ extends: [base, …], … })` with relative imports ending in `.ts`:
  - `app/server`: `base`, `tests`; `require-yield: 'off'` (a generator passed to `Effect.gen`/`Effect.fn` does not
    always yield).
  - `app/src`: `base`, `react`, `tests`; ignores `components/ui/**`.
  - `site`: `base`, `react`, `tests`; ignores `src/components/ui/**`, `build`, `dist`, `.react-router`.
  - `packages/llamacpp-js`: `base` only (its tests run on `node:test`: no Vitest rule);
    `typescript/no-floating-promises` stays in the debt block for L4.
  - The root config, as is, covers `scripts/`, `app/build`, `app/bin`, `packages/webui-shared`, `packages/webui-theme`
    and the root files; add `tests` to the base's `extends`/`overrides` for those test files.
- [ ] **Step 2:** `pnpm exec oxlint .`. Expected: 0 error, 0 warning apart from what Task 4 converts. A report that
      appears only once the project configs exist means a rule moved between configs: fix the config, not the code.
- [ ] **Step 3:** Commit: `chore: per-project oxlint configs`.

### Task 4: Suppressions, Biome out

**Files:**

- Modify: the 22 files that hold the 30 `biome-ignore` (`git grep -n biome-ignore -- ':!*.md' ':!*.mdx' ':!docs'`),
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (only if it names Biome)
- Delete: `biome.jsonc`

- [ ] **Step 1:** Convert each comment to `// oxlint-disable-next-line <rule> -- <its reason, unchanged>` (in JSX,
      `{/* oxlint-disable-next-line … */}` as the existing comment is written):

  | Biome                                   | oxlint                                                                     | Count |
  | --------------------------------------- | -------------------------------------------------------------------------- | ----: |
  | `suspicious/noArrayIndexKey`            | `react/no-array-index-key`                                                 |    10 |
  | `correctness/useExhaustiveDependencies` | `react-hooks/exhaustive-deps`                                              |    10 |
  | `security/noDangerouslySetInnerHtml`    | `react/no-danger`                                                          |     2 |
  | `suspicious/noControlCharactersInRegex` | `no-control-regex`                                                         |     1 |
  | `a11y/*`                                | its `jsx-a11y` equivalent if that rule is on, otherwise remove the comment |     2 |
  | `correctness/noComponentHookFactories`  | none: remove the comment                                                   |     2 |
  | `complexity/noImportantStyles` (CSS)    | none: remove the comment                                                   |     3 |

  These four React rules are on in `oxlint.react.ts` (they are Biome's today), not in the debt block.

- [ ] **Step 2:** `pnpm exec oxlint --deny-warnings --report-unused-disable-directives .`. Expected: exit 0. An unused
      directive: the rule reports on another line (move the comment) or not at all (remove it). A new report: the
      directive names the wrong rule.
- [ ] **Step 3:** `pnpm remove -w @biomejs/biome`, delete `biome.jsonc`. Scripts: `"lint": "oxfmt --check && oxlint
  --deny-warnings --report-unused-disable-directives"`, `"lint:fix": "oxlint --fix && oxfmt"`, `"format": "oxfmt"`.
- [ ] **Step 4:** `git grep -n -i biome -- ':!docs' ':!*.md' ':!*.mdx'`. Expected: nothing left (the lockfile
      included).
- [ ] **Step 5:** `pnpm lint && pnpm check && pnpm test`. Commit: `chore: replace Biome with oxlint`.

### Task 5: Proof that each config applies

- [ ] **Step 1:** For one source file and one test file of each project (server, web, site, `llamacpp-js`, shared,
      `scripts`), `pnpm exec oxlint --print-config <file>`: `require-yield` is off only for the server, `react/*` rules
      appear only for the web and the site, `vitest/*` only for the Vitest test files, never for `llamacpp-js`.
- [ ] **Step 2:** Plant one violation per project, run `pnpm lint`, expect exit 1 with the named rule, then remove it:
      `debugger;` in a server file (`no-debugger`); a hook called inside an `if` in a web component and in a site
      component (`react-hooks/rules-of-hooks`); `expect(1);` with no matcher in a web test (`vitest/valid-expect`); a
      `// oxlint-disable-next-line no-debugger` without reason in `llamacpp-js` (`directives/require-reason` and the
      unused directive).
- [ ] **Step 3:** A file under `app/src/components/ui` and `repos/effect` given explicitly to oxlint is reported as
      ignored, not linted.
- [ ] **Step 4:** Time `pnpm lint` (three runs). Put the figure in the PR; above 60 s on the CI runner, the lint moves
      to a job of its own in `ci.yml`.

### Task 6: Documentation and PR

**Files:**

- Modify: `CLAUDE.md` ("Format et lint" rewritten for oxfmt and oxlint: the files of "Architecture" above, the three
  scripts, the suppression syntax, the debt block and its rule; the sentence about Biome and `catalog:` in
  "Installation (pnpm)" removed; "`correctness/useYield` est coupée…" removed, its reason now lives in
  `app/server/oxlint.config.ts`; "Une correction `--unsafe`…" removed after checking once that `oxlint --fix` does
  not drop a comment attached to an unused import; the site section's "Biome sans warning"),
  `README.md` (lines 252-253, 326-329, 338), `site/content/developers/contributing/conventions.mdx` (lines 3, 7,
  74-128, 211), `getting-started.mdx` (134-136, 220, 287-300), `index.mdx` (40, 83), `frontend.mdx` (51),
  `contributing/testing.mdx` (217, 401), `contributing/workflow.mdx` (46, 230), `.github/workflows/ci.yml` (line 1)

- [ ] **Step 1:** Rewrite each for what is now true. The examples of suppressions in `conventions.mdx` become real
      ones taken from the code after Task 4. The editor note gains `"source.fixAll.oxc": "explicit"`.
- [ ] **Step 2:** `pnpm format`; `pnpm site:build && pnpm --dir site check-links`; `pnpm lint && pnpm check && pnpm test`;
      `pnpm build && node scripts/smoke.ts`.
- [ ] **Step 3:** Commit: `docs: oxlint and oxfmt replace Biome`.
- [ ] **Step 4:** Push, PR `chore: Replace Biome with oxlint`. Body: the parity table's totals (185 kept, the losses of
      the spec), the debt block as a checklist for L4 and L5, the timing. End with
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
