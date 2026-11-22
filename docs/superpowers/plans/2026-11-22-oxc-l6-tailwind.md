# oxc migration, L6: Tailwind

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** oxfmt orders the Tailwind classes and `oxlint-tailwindcss` lints them, in the web and in the site, with no
visual change.

**Architecture:** `sortTailwindcss` in `oxfmt.config.ts`, one override per project for its stylesheet. The plugin as a
JS plugin in `app/src/oxlint.config.ts` and `site/oxlint.config.ts`, each with its `entryPoint`.

**Tech Stack:** oxfmt 0.79.0, oxlint 1.94.0, `oxlint-tailwindcss` 1.17.2 (exact), Tailwind 4, `@llama-webui/theme`.

**Spec:** `docs/superpowers/specs/2026-11-22-oxc-migration-design.md` ("Tailwind (L6)") and appendix §4 and §5.

## Global Constraints

- Branch `chore/lint-tailwind` from `refactor/lint-react` (stacked; the PR is based on it); one PR; green on `pnpm lint`,
  `pnpm check`, `pnpm test`.
- **No visual change**: a report is fixed only by an equivalent form (a shorthand, a canonical spelling, a hex colour
  replaced by the theme token of exactly that value). A colour without such a token keeps its value under a
  suppression with its reason. No token is added to `packages/webui-theme`, no colour changes, no screenshot retaken.
- oxfmt owns class order and wrapping: `tailwindcss/enforce-sort-order` and
  `tailwindcss/enforce-consistent-line-wrapping` stay off.
- `**/src/components/ui` (shadcn) is neither sorted nor linted.

## Review Focus

- Class order changing the result: two utilities of the same property and the same variant in one class list
  (`p-2 p-4`), where the later one in the CSS wins regardless of order: sorting must not change the outcome, and
  `tailwindcss/no-conflicting-classes` reports the pair. Read each such report rather than trust the sort.
- A shorthand that is not equivalent under a variant (`sm:top-2 bottom-2` is not `inset-y-2`).
- A class of `@llama-webui/theme` (`aurora`…) reported as unknown, then "fixed" by deleting it.
- Class strings outside `className`, `cn(…)` and `cva(…)` (a constant, a map of variants): not sorted by oxfmt;
  left as they are.

---

### Task 1: Class order

**Files:**

- Modify: `oxfmt.config.ts`; rewritten by the formatter: about 56 files under `app/src` and `site/src`

- [ ] **Step 1:** Add two overrides: `{ files: ['app/**'], options: { sortTailwindcss: { stylesheet: './app/src/index.css', functions: ['cn', 'cva'] } } }`
      and the same for `site/**` with `./site/src/styles/app.css`.
- [ ] **Step 2:** `pnpm format`. Expected: about 56 files, about 100 lines, class order only
      (`git diff -U0 | grep '^[+-]' | grep -v 'class\|cn(\|cva(' ` shows nothing but multi-line class lists).
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`. Commit the config (`chore: oxfmt orders the Tailwind classes`),
      then the output alone (`style: order the Tailwind classes`).

### Task 2: The lint plugin

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`, `app/src/oxlint.config.ts`, `site/oxlint.config.ts`

- [ ] **Step 1:** `pnpm add -D -w -E oxlint-tailwindcss@1.17.2`. In both configs: `jsPlugins: ['oxlint-tailwindcss']`,
      `settings.tailwindcss.entryPoint` (`index.css` for `app/src`, `src/styles/app.css` for `site`: relative to the
      config file), and the plugin's recommended rules by name in `error` (the list in its README, "Setup"): every rule
      it marks `error` or `warn`, minus the two of the constraints. Its opt-in rules stay off.
- [ ] **Step 2:** `tailwindcss/no-unknown-classes`: allow the non-utility classes that `packages/webui-theme/theme.css`
      and the two stylesheets define (`aurora` and the others the first run names), through the rule's own allow option;
      the list carries a comment saying where the classes come from.
- [ ] **Step 3:** `pnpm exec oxlint -f json app/src site`, group by rule. Expected: about 34 reports minus the 14 of
      `no-unknown-classes` once allowed and the 4 of `enforce-sort-order`.
- [ ] **Step 4:** Commit: `chore: lint Tailwind classes with oxlint-tailwindcss`.

### Task 3: The reports

- [ ] **Step 1:** `enforce-canonical` (5), `enforce-shorthand` (4), `consistent-variant-order` (1): apply the form the
      rule proposes after checking it is equivalent (Review Focus).
- [ ] **Step 2:** `no-hardcoded-colors` (6, all in the site): for each hex, look for a token of exactly that value in
      `packages/webui-theme/theme.css`; use it if it exists, otherwise
      `// oxlint-disable-next-line tailwindcss/no-hardcoded-colors -- <what the colour reproduces>`.
- [ ] **Step 3:** Any other rule that reports: same test of equivalence; a rule whose every fix would change the
      rendering goes off with its reason.
- [ ] **Step 4:** `pnpm site:build`; with `pnpm dev` (`LLAMA_WEBUI_HOST=0.0.0.0`, `http://192.168.0.20:7860`) and
      `pnpm site:dev`, open each page whose classes changed in this task (not the pure reorder of Task 1) and compare
      with `master` side by side.
- [ ] **Step 5:** `pnpm lint && pnpm check && pnpm test`. Commit: `style: canonical Tailwind classes`.

### Task 4: Documentation and PR

**Files:**

- Modify: `CLAUDE.md` ("Format et lint": Tailwind classes ordered by oxfmt, linted by the plugin, where the allowed
  theme classes are listed), `site/content/developers/contributing/conventions.mdx`,
  `site/content/developers/frontend.mdx` (styling section). `.git-blame-ignore-revs` is one small PR after the
  last merge (spec, "Sequencing"): nothing here

- [ ] **Step 1:** Update, `pnpm format`, `pnpm site:build && pnpm --dir site check-links`.
- [ ] **Step 2:** Time `pnpm lint` (three runs); above 60 s on the CI runner the lint gets its own job in
      `.github/workflows/ci.yml`.
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`; `pnpm build && node scripts/smoke.ts`. Commit, push, PR
      `chore: Order and lint Tailwind classes`. Body: files reordered, reports fixed by rule, suppressions with their
      reasons, the timing, "no visual change" with the pages compared. End with
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
