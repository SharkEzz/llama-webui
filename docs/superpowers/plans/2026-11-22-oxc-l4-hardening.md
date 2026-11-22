# oxc migration, L4: general and type-aware hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The general rule selection of the spec is on, in `error`, in every project, and the L4 part of the debt
block of `oxlint.config.ts` is empty.

**Architecture:** One family of rules per task: the rule on, its reports fixed, a commit. Fixes preserve behaviour;
the test suites and the contract golden are the proof. About 680 reports, about 70 with a safe autofix.

**Tech Stack:** oxlint 1.94.0 with oxlint-tsgolint, Vitest, the Effect server, React.

**Spec:** `docs/superpowers/specs/2026-11-22-oxc-migration-design.md` ("The selection" › L4, "Declined") and appendix
§2 (counts per rule and per project), §3 (options).

## Global Constraints

- Starts once the L3 PR is merged. Branch `refactor/lint-hardening` from `master`. Green on `pnpm lint`, `pnpm check`
  (0 `effect(` line), `pnpm test`.
- **Behaviour does not change.** `app/server/contract/golden.json` is not regenerated; no test is weakened, skipped
  or deleted to pass a rule. A fix that would change behaviour is a finding: write it in the PR and suppress the line
  with its reason instead.
- A rule that turns out wrong on this code (false positives, not inconvenience) leaves the selection in the same
  commit: off with its reason and two examples, and a line in the PR body. Never `warn`.
- A suppression is the exception: `// oxlint-disable-next-line <rule> -- <reason>`, counted in the PR body. More
  than a tenth of a rule's reports suppressed means the rule or its options are wrong for this code: stop and decide.
- Server code follows `docs/superpowers/poc-effect/conventions.md` and `repos/effect/LLMS.md` (read both before
  touching `app/server/` or `packages/webui-shared/src/api/`). Web code: no cast on a response, errors told apart by
  `_tag`.
- No sorting rule. Accessibility rules untouched. The five rules the user declined stay off: `curly`,
  `typescript/strict-boolean-expressions`, `typescript/no-non-null-assertion`, `vitest/prefer-strict-equal`,
  `no-nested-ternary`.
- **Size:** if the branch passes about 1,500 changed lines, it is split into three PRs in this order, each from
  `master` after the previous one is merged: Tasks 1-2, Task 3, Tasks 4-7.

## Review Focus

- A `void` added in front of a promise that was meant to be awaited (order of effects changes): for each
  `no-floating-promises` fix, the call was already fire-and-forget before.
- An interface method turned into a property on a type that a class implements with a method, or that relies on
  method bivariance: `pnpm check` is the judge, and a `tsc` error there is a reason to keep that one signature as a
  method with a suppression.
- `.sort()` replaced by `.toSorted()` where the caller relied on the array being sorted in place afterwards.
- A "useless" condition removed that guarded data coming from outside the type system (a JSON body, a `/proc` file,
  llama.cpp output): keep the guard, fix the type, or suppress with the reason.
- A cast replaced by a guard that now throws or returns early on input the cast used to let through.

---

### Task 1: The two categories

- [ ] **Step 1:** `categories`: add `suspicious: 'error'` and `perf: 'error'`. Off, with their reason:
      `no-underscore-dangle` (`_tag` is Effect's discriminant), `typescript/consistent-return` (misreads `Effect.gen`
      generators), `unicorn/consistent-function-scoping`, `no-await-in-loop` (sweeps, retries and tests are sequential on
      purpose), `promise/always-return` (`.then` used for its effect). `import/no-unassigned-import` allows `**/*.css` and
      `@llama-webui/theme/*`.
- [ ] **Step 2:** `pnpm exec oxlint -f json .`, group by rule. Every rule of these two categories that reports and is
      not handled by a later task of this plan (`react/*` and `vitest/*` wait for L5) is fixed here: expected
      `unicorn/no-array-sort` 29, `unicorn/prefer-add-event-listener` 7, `typescript/no-unnecessary-type-conversion` 4,
      `oxc/no-map-spread` 5, `unicorn/prefer-set-has` 4, `import/no-named-as-default-member` 2,
      `typescript/no-unnecessary-boolean-literal-compare` 2 and a few at 1. A rule not in the spec's tables that reports
      more than 10 times: stop, it was not measured, decide with the two questions of the constraints.
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: turn on the suspicious and perf rules`.

### Task 2: Method signatures and unbound methods

- [ ] **Step 1:** Turn on `typescript/method-signature-style` (default `property`). 148 reports (112 web, 31 server,
      5 site), no autofix: `name(args): R;` becomes `name: (args) => R;` in interfaces and type literals. Overloaded
      methods keep their shape with a suppression.
- [ ] **Step 2:** `pnpm check`. Expected: green. Fix what the stricter variance reveals in the implementation, not by
      loosening the type.
- [ ] **Step 3:** Remove `typescript/unbound-method` from the debt block. Expected: its 82 web reports are gone or
      nearly; what is left is a real method read off its object: bind it or wrap it.
- [ ] **Step 4:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: declare interface functions as properties`.

### Task 3: The unsafe family

- [ ] **Step 1:** Turn on `typescript/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-argument`,
      `no-unsafe-return`, `no-unsafe-call` (43 reports) and fix: the `any` comes from `JSON.parse`, a catch variable or an
      untyped import; give it a type by decoding (`Schema` on the server and in shared code, an existing guard in the
      web), not by a cast.
- [ ] **Step 2:** Turn on `typescript/no-unsafe-type-assertion` with an override that switches it off for test files
      and `app/server/testing/**` (64 reports left: server 49 and web 36 before removing their tests). Each `as` is
      replaced by a decode, a guard, a `satisfies`, or a narrower declaration. An `as` on the result of a DOM or library
      API whose type is wider than what it returns keeps a suppression with that reason.
- [ ] **Step 3:** Turn on `typescript/use-unknown-in-catch-callback-variable` (8) and `typescript/no-base-to-string`
      (16: `String(x)` on a value that may be an object; narrow first).
- [ ] **Step 4:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: remove unsafe any flows and assertions`.

### Task 4: Promises and void

- [ ] **Step 1:** `typescript/no-floating-promises` with `allowForKnownSafeCalls` for `test`, `it`, `describe`,
      `suite` from `node:test` (7 left: `navigate(…)` of React Router → `void navigate(…)`).
- [ ] **Step 2:** `typescript/no-misused-promises` (23): a promise-returning function passed where `void` is expected
      (event handlers) is wrapped as `() => void fn()`, keeping who handles its rejection.
- [ ] **Step 3:** `typescript/no-confusing-void-expression` with `ignoreArrowShorthand: true`,
      `ignoreVoidOperator: true` (15); `typescript/require-await` (and `require-await` off, the same check without types);
      `typescript/prefer-promise-reject-errors`; `typescript/await-thenable`.
- [ ] **Step 4:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: make discarded promises explicit`.

### Task 5: Conditions

- [ ] **Step 1:** `typescript/no-unnecessary-condition` (41, nursery). Read each before deleting anything (Review
      Focus). If more than 8 of the 41 are wrong about the types, the rule goes off with its reason.
- [ ] **Step 2:** `typescript/prefer-optional-chain` (6), `typescript/prefer-nullish-coalescing` (12),
      `typescript/switch-exhaustiveness-check` (4), `typescript/no-unnecessary-type-assertion` (19, safe autofix),
      `typescript/no-useless-default-assignment` (6: read them; off if it misreads `noUncheckedIndexedAccess`),
      `typescript/no-redundant-type-constituents`, `typescript/no-duplicate-type-constituents`.
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: remove conditions the types rule out`.

### Task 6: Shadowing and the small rules

- [ ] **Step 1:** `no-shadow` (40, 22 in tests): rename the inner binding.
- [ ] **Step 2:** `no-implicit-coercion` (15), `unicorn/prefer-string-replace-all` (13), `typescript/prefer-includes`
      (7), `unicorn/prefer-at` (4), `unicorn/no-new-array` (4), `typescript/restrict-template-expressions` (4),
      `typescript/restrict-plus-operands` (3), `typescript/consistent-type-definitions` (3), `typescript/prefer-readonly`
      (3), `typescript/prefer-regexp-exec`, `typescript/no-deprecated`, `typescript/prefer-string-starts-ends-with`,
      `prefer-arrow-callback`, `typescript/no-inferrable-types`, and what is left of the debt block marked L4.
- [ ] **Step 3:** `no-console`: on in `app/server/oxlint.config.ts` and `app/src/oxlint.config.ts` only (2 reports
      each). The two of the web report a message of the server that does not decode: they keep `console.error` under a
      suppression with that reason, unless the code has a reporting path already. The server's go through its logger.
- [ ] **Step 4:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor: shadowing, coercions and small lint rules`.

### Task 7: Closing

**Files:**

- Modify: `oxlint.config.ts` (debt block), `CLAUDE.md`, `site/content/developers/contributing/conventions.mdx`,
  `site/content/developers/contributing/testing.mdx`

- [ ] **Step 1:** The debt block holds only `// L5` lines. `git grep -c 'oxlint-disable' -- app packages site scripts`
      against its value on `master`: the difference, per rule, goes in the PR body.
- [ ] **Step 2:** Docs: the sentence "toujours `await expect(…).rejects`" of `CLAUDE.md` › Testing becomes a pointer to
      the rules that enforce it (`typescript/no-floating-promises`, `vitest/valid-expect`); `conventions.mdx` lists the
      families now enforced (unsafe `any`, discarded promises, interface functions as properties) in a short table.
      `pnpm format`; `pnpm site:build && pnpm --dir site check-links`.
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`; `pnpm build && node scripts/smoke.ts`. Commit, push, PR
      `refactor: Harden the lint (general and type-aware rules)`. Body: the rules on with their counts, the rules dropped
      with their reason, the suppressions added, any behaviour finding. End with
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
