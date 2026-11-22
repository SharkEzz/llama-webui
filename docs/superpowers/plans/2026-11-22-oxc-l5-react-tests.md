# oxc migration, L5: React and tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The React rules (native and ten of react-doctor) and the Vitest rules of the spec are on in `error`, and
the debt block of `oxlint.config.ts` is gone.

**Architecture:** `oxlint.react.ts` and `oxlint.tests.ts` grow; the web (`app/src`) and the site are fixed component
by component. A fix here can change what a screen does, so each touched component is exercised in the running app.

**Tech Stack:** oxlint 1.94.0, `oxlint-plugin-react-doctor` 0.9.23 (exact, JS plugin), React 19, Zustand, React Router.

**Spec:** `docs/superpowers/specs/2026-11-22-oxc-migration-design.md` ("react-doctor", "The selection" › L5) and
appendix §2 and §6 (each react-doctor report with its file and line).

## Global Constraints

- Starts once the last L4 PR is merged. Branch `refactor/lint-react` from `master`; one PR; green on `pnpm lint`,
  `pnpm check`, `pnpm test`.
- **Screens behave as before**, except where the rule found a bug (a busy flag stuck after a failure, a write to
  `localStorage` inside an updater, a state mirrored one render late): those fixes are listed in the PR body with how
  each was checked. No visual change, no screenshot retaken.
- React idioms of the project: a `key` on the component to reset state on a change of identity, not an effect;
  `useEffectEvent` to read the latest value in an effect; a deliberate trigger dependency keeps its
  `react-hooks/exhaustive-deps` suppression with its reason.
- react-doctor: the plugin only (never the `react-doctor` CLI), ten rules and no other. The user accepted its licence.
- Accessibility rules untouched. `react-perf` not enabled. No sorting rule.
- The app is opened at `http://192.168.0.20:7860` (never `localhost`), started with `LLAMA_WEBUI_HOST=0.0.0.0 pnpm dev`.
  A test port is never 7860, 7861 nor 8080.
- A rule wrong on this code leaves the selection with its reason and two examples; never `warn`.

## Review Focus

- A `useEffect(() => setX(prop), [prop])` replaced by a `key` remount that also resets state the user was typing
  (a draft, a scroll position, an open popover): the component keeps what it kept before.
- State derived during render instead of in an effect, read by a handler one render earlier than before.
- The three.js scene (`topology/TopologyScene.tsx`): the pacer object is mutated from frame and event callbacks on
  purpose; a "fix" that makes it state would re-render the canvas at every frame.
- A Zustand selector added where the whole store was read: the component must still update on every field it uses.
- An IME guard added to an Enter handler that also handles Shift+Enter or Escape: those paths unchanged.

---

### Task 1: Native React rules

**Files:**
- Modify: `oxlint.react.ts`, `oxlint.config.ts` (debt block), the reported files under `app/src` and `site/src`

- [ ] **Step 1:** Remove the `// L5` React lines from the debt block; in `oxlint.react.ts`, off with their reason:
  `react/hooks` (reads `useStore.getState()` of Zustand as a hook used as a value),
  `react/exhaustive-effect-dependencies` (same check as `react-hooks/exhaustive-deps`, which stays).
  `react/no-unescaped-entities` on.
- [ ] **Step 2:** `react/set-state-in-effect` (13: 11 web, 2 site). For each, in this order of preference: derive the
  value during render; reset with a `key`; move the update to the event that causes it; keep the effect when it
  synchronizes with something outside React (a fetch result, a subscription) and the rule still reports: suppression
  with that reason. `chat/useServerProps.ts:15` and `server/ServerPage.tsx:216` (`setProps(null)` before a fetch) are
  of the last kind unless the state can be keyed by its input.
- [ ] **Step 3:** `react/immutability` (14, all in `features/topology/TopologyScene.tsx`): read how `pacer` is created.
  If it is a plain object made during render, hold it in a ref (`useRef`) so its mutation from callbacks is legal; do
  not turn it into state.
- [ ] **Step 4:** `react/refs` (2: `components/charts/TimeSeriesChart.tsx:61` writes `fmt.current` during render,
  `site/src/landing/useSimulation.ts:11`), `react/no-object-type-as-default-prop` (1), `react/incompatible-library`
  (1: `useVirtualizer` in `logs/LogsPage.tsx`; a suppression with the reason, the library is the choice),
  `react/memo-dependencies` (1), `react/no-unescaped-entities` (6).
- [ ] **Step 5:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor(web): fix what the React rules report`.

### Task 2: react-doctor

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `oxlint.react.ts`, `site/oxlint.config.ts`, the eleven reported files

- [ ] **Step 1:** `pnpm add -D -w -E oxlint-plugin-react-doctor@0.9.23`. In `oxlint.react.ts`:
  `jsPlugins: [{ name: 'react-doctor', specifier: 'oxlint-plugin-react-doctor' }]` and, in `error`:
  `no-mirror-prop-effect`, `no-reset-all-state-on-prop-change`, `no-set-state-after-await-in-effect`,
  `no-loading-flag-reset-outside-finally`, `no-impure-state-updater`, `zustand-no-whole-store-destructure`,
  `no-enter-submit-without-ime-composition-guard`, `react-router-require-root-error-boundary`,
  `rerender-state-only-in-handlers`. In `site/oxlint.config.ts` only:
  `react-doctor/no-unguarded-browser-global-in-render-or-hook-init` (the site prerenders; 0 report).
- [ ] **Step 2:** `pnpm exec oxlint -f json app/src site`. Expected: 12 reports of these rules, at the places of
  appendix §6 (some already gone with Task 1). Fix each:
  `tuning/ModelCard.tsx:170` and `chat/SamplingPanel.tsx:111` (mirror of a prop: derive or `key`);
  `site/src/components/SearchDialog.tsx:78` (an ignore flag or an `AbortController` in the effect's cleanup);
  `models/hf/RepoView.tsx:177` (`setBusy(false)` in a `finally`); `topology/hudPrefs.ts:31` (the `localStorage` write
  after computing the next state, outside the updater); `lib/flags.ts:17` (selectors);
  `profiles/ArgsEditor.tsx:81`, `tuning/SpaceEditor.tsx:242` and the third report (return early when
  `event.nativeEvent.isComposing`); `app/router.tsx:26` (an `errorElement`/`ErrorBoundary` on the root route, reusing
  the app's existing error presentation if there is one, otherwise a minimal one in the app's style);
  `profiles/ArgsEditor.tsx:29` (`navigated`: a ref if it is never rendered).
- [ ] **Step 3:** Time `pnpm lint` before and after the plugin; both figures go in the PR body.
- [ ] **Step 4:** `pnpm lint && pnpm check && pnpm test`. Commit: `refactor(web): add ten react-doctor rules`.

### Task 3: Vitest rules

**Files:**
- Modify: `oxlint.tests.ts`, `oxlint.config.ts`, the reported test files

- [ ] **Step 1:** Remove the `// L5` Vitest lines from the debt block. On: `vitest/no-conditional-expect` (2,
  `site/src/landing/telemetry.test.ts`), `vitest/require-mock-type-parameters` (2), `vitest/require-to-throw-message`
  (1), `vitest/prefer-to-have-length` (2), `vitest/prefer-called-times` (2). Fix the 9 reports without weakening an
  assertion.
- [ ] **Step 2:** The debt block is empty: delete its two delimiter comments.
- [ ] **Step 3:** `pnpm lint && pnpm check && pnpm test`. Commit: `test: fix what the Vitest rules report`.

### Task 4: The screens

- [ ] **Step 1:** `LLAMA_WEBUI_HOST=0.0.0.0 pnpm dev`, open `http://192.168.0.20:7860`. For every component changed in
  Tasks 1 and 2, do the interaction the change is about and compare with `master` behaviour: Tuning model card field
  after the model changes; Chat sampling panel after switching conversation; Hugging Face repo view after a failed
  action (the button is usable again); Topology HUD cards collapse and survive a reload; Topology scene orbit and
  idle; Logs page scroll; Profiles arguments editor (Enter, Shift+Enter, completion); Tuning space editor; a broken
  route shows the error boundary. For the site: `pnpm site:dev`, the search dialog (type fast, results match the last
  query) and the landing simulation.
- [ ] **Step 2:** Write, for the PR body, one line per component: what changed, what was done to check it.

### Task 5: Documentation and PR

**Files:**
- Modify: `CLAUDE.md` ("Format et lint": the sentence about `key` rather than an effect becomes a pointer to
  `react/set-state-in-effect` and the react-doctor rules; the `useEffectEvent` advice stays),
  `site/content/developers/contributing/conventions.mdx` (React idioms: the rules that enforce them; the react-doctor
  plugin, its ten rules and its licence terms), `site/content/developers/frontend.mdx` if it describes these idioms,
  `README.md` (acknowledgements line, if tools are listed there)

- [ ] **Step 1:** Update, `pnpm format`, `pnpm site:build && pnpm --dir site check-links`.
- [ ] **Step 2:** `pnpm lint && pnpm check && pnpm test`; `pnpm build && node scripts/smoke.ts`. Commit, push, PR
  `refactor: Harden the lint (React and tests)`. Body: rules on, rules off with reasons, the per-component list of
  Task 4, the timing. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
