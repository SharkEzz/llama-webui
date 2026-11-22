# oxc migration, L7: import bans and closing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The import boundaries between the projects are lint rules, and no written convention repeats what the
linter enforces.

**Architecture:** `no-restricted-imports` in each project config, `import/no-cycle` in the base. No code changes: a
ban that reports today is a ban written wrong. Then a last pass over `CLAUDE.md`, `README.md` and the site.

**Tech Stack:** oxlint 1.94.0.

**Spec:** `docs/superpowers/specs/2026-11-22-oxc-migration-design.md` ("The selection" › L7, "What leaves the written
conventions").

## Global Constraints

- Branch `chore/lint-architecture` from `chore/lint-tailwind` (stacked; the PR is based on it); one PR; green on `pnpm lint`,
  `pnpm check`, `pnpm test`.
- **No source change.** The tests that check the same boundaries on the build stay as they are
  (`app/server/build.test.ts`, `scripts/package.test.ts`, `packages/llamacpp-js/tests/package.test.ts`).
- The `node:*` bans are for source files: test files (`**/*.test.ts`, `**/*.test.tsx`, `packages/llamacpp-js/tests/**`)
  and `app/server/testing/**` are exempt. The other bans apply to tests too.
- In `app/server`, `node:*` stays the business of the Effect diagnostics (`nodeBuiltinImport` in `tsc`): no oxlint
  ban on it there.
- Each ban carries a message that says what to use instead.

## Review Focus

- A ban written as a package name that a relative path walks around (`../../server/x.ts` from `app/src`): the
  patterns cover both the specifier and the relative forms that reach the directory.
- A type-only import across a boundary (`import type { X } from '../server/…'`): banned as well; the shared types
  live in `@llama-webui/shared`.
- A dynamic `import()` or a re-export (`export * from`) across a boundary.
- A ban that also catches the allowed neighbour (`@llama-webui/theme` from the site, `llamacpp-js/node` from the
  server).

---

### Task 1: The bans

**Files:**

- Modify: `oxlint.config.ts`, `app/src/oxlint.config.ts`, `site/oxlint.config.ts`,
  `packages/llamacpp-js/oxlint.config.ts`, `app/server/oxlint.config.ts`
- Create: `packages/webui-shared/oxlint.config.ts` (if it does not exist yet: `extends` the base and the test fragment)

- [ ] **Step 1:** `no-restricted-imports` with `patterns` (and `paths` for exact names):

  | Config                  | Banned                                                                                                                                          | Message                                                                    |
  | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
  | base (everyone)         | `repos/**` and any relative path into `repos/`                                                                                                  | the vendored repositories are reference material, import the package       |
  | `app/src`               | `app/server/**` (relative forms: `**/server/**` reached from `app/src`), `node:*`                                                               | the web talks to the server through `@llama-webui/shared` and `lib/api.ts` |
  | `site`                  | anything under `app/` (relative forms and `@llama-webui/app`), `@llama-webui/shared` only if the site does not use it today                     | the site copies what it reuses; tokens come from `@llama-webui/theme`      |
  | `packages/llamacpp-js`  | `@llama-webui/*`, `effect`, `@effect/*`; `node:*` in `src/**` outside the files behind its `node` export (read `exports` in its `package.json`) | the package has no dependency; Node APIs live behind `llamacpp-js/node`    |
  | `packages/webui-shared` | `app/**` (relative), `@llama-webui/app`, `node:*` in source files                                                                               | shared code runs in the browser                                            |
  | `app/server`            | `better-sqlite3`, `bun:*`, `node:sqlite` outside `app/server/db/` only if that is how it is today                                               | SQLite goes through `SqlClient` (`app/server/db/Db.ts`)                    |

  Before writing a row, `git grep` the imports it would ban: a row that would report on today's code is narrowed to
  what the code does (and the difference noted in the PR), never fixed by changing code.

- [ ] **Step 2:** `import/no-cycle: 'error'` in the base. Expected: 0 report (measured in the spike). A cycle found
      now that the run is complete: report it in the PR and leave the rule off with a `// TODO(cycle): <files>` comment
      rather than restructure code in this milestone.
- [ ] **Step 3:** `pnpm lint`. Expected: exit 0 with no source change.
- [ ] **Step 4:** Plant one import per row (including one relative path, one `import type`, one `export … from`), run
      `pnpm lint`, expect exit 1 with the row's message; remove each. Check the exemptions: `node:child_process` in
      `app/server/testing/launch.ts` and `node:test` in `packages/llamacpp-js/tests/` are not reported.
- [ ] **Step 5:** Commit: `chore: lint the import boundaries between projects`.

### Task 2: The written conventions

**Files:**

- Modify: `CLAUDE.md`, `README.md`, `site/content/developers/contributing/conventions.mdx`,
  `site/content/developers/contributing/workflow.mdx`, `site/content/developers/getting-started.mdx`,
  `site/content/developers/frontend.mdx`

- [ ] **Step 1:** Go through the table "What leaves the written conventions" of the spec, row by row, and through
      `CLAUDE.md` from top to bottom. A sentence that states what a lint rule now enforces is replaced by the name of the
      rule and of the config file that holds it, or removed when the rule's own message says it. What no rule checks
      stays, word for word: `useEffectEvent` rather than a suppression, "jamais de `fetch('/api…')`", "jamais de cast sur
      une réponse", the locale and `_tag` rules, everything about Effect, the vendored repositories as read-only
      reference. `CLAUDE.md` stays in French.
- [ ] **Step 2:** `conventions.mdx`: one section "What the linter enforces" with the config files, the families of
      rules per project and the import bans table; `workflow.mdx`: a row in "Keep the docs in sync" for the lint
      configuration (`oxlint*.ts`, `oxfmt.config.ts`, `scripts/oxlint/` → `contributing/conventions.mdx`).
- [ ] **Step 3:** `git grep -n -i 'biome' -- ':!docs/superpowers'`. Expected: nothing.
- [ ] **Step 5:** `pnpm format`; `pnpm site:build && pnpm --dir site check-links`; `pnpm lint && pnpm check && pnpm test`;
      `pnpm build && node scripts/smoke.ts`. Commit: `docs: conventions the linter enforces leave the written rules`.

### Task 3: Closing

- [ ] **Step 1:** Against the spec, check and write in the PR body: the debt block is gone; no rule is `warn`
      (`git grep -n "'warn'" -- '*oxlint*.ts'` gives nothing); every rule that is off has its reason on its line; the
      count of suppressions per rule (`git grep -h -o 'oxlint-disable[a-z-]* [a-z/@-]*' | sort | uniq -c`); the losses
      of the spec, unchanged or with what changed; the lint's duration locally and in CI.
- [ ] **Step 2:** Push, PR `chore: Lint the import boundaries and close the oxc migration`. End with
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **The user validates the migration on this PR.**
