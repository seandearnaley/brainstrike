# React Doctor migration & remediation plan (2026-06-15)

Replaces standalone **knip** in CI with **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.5.5`), which runs knip-style dead-code analysis **and** ~250 React/JS lint
rules. This doc is the durable plan for the stacked-PR remediation that follows.

## How React Doctor actually works (reverse-engineered from v0.5.5)

- Two passes: **lint** (oxlint + react-hooks engines; categories Security / Bugs /
  Performance / Accessibility / Maintainability) and **deadCode** (the `deslop` engine).
- `deslop` is **not** knip. It reads knip's `entry` + `ignore` patterns — but only from a
  strict-JSON **`knip.json`** or **`package.json#knip`**, *never* `knip.jsonc` (plain
  `JSON.parse`, comments → ignored). It does **not** read knip's `ignoreDependencies` and
  has **no per-dependency allowlist** (`dist/index.js` `collectKnipPatterns` is only ever
  called for `"ignore"`/`"entry"`; `checkDeadCode` emits unused-dependency diagnostics
  with no allowlist filter).
- **Consequence:** the ~59 `unused-(dev-)dependency` findings are false positives already
  curated in `knip.jsonc` (CSS `@import`s, lazy prebundles, dynamic requires, peer deps).
  React Doctor cannot suppress them per-dep. → We **disable** `deslop/unused-dependency` +
  `deslop/unused-dev-dependency` and **keep knip** as the dependency auditor (`pnpm knip`).
- Telemetry (hosted score API + share URL + Sentry) is **opt-out**: `noScore`/`share:false`
  in `doctor.config.ts`, plus `REACT_DOCTOR_NO_TELEMETRY=1` in CI (the Action has no flag).

## Configuration decisions (locked)

| Decision    | Choice                                                              |
| ----------- | ------------------------------------------------------------------ |
| Telemetry   | OFF (`noScore`, `share:false`, `REACT_DOCTOR_NO_TELEMETRY=1`)       |
| CI gate     | `scope: changed` + `blocking: error` — only NEW errors fail a PR    |
| CI runner   | Official `millionco/react-doctor@v2` Action (PR comments + status)  |
| knip        | Retained for dependency dead-code; deslop dep rules disabled        |
| Lint ignores| **None** — `ignore.files` is unsafe in 0.5.5 (see gotcha below)     |

### Gotcha: never use `ignore.files` (react-doctor 0.5.5)

Setting a non-empty `ignore.files` flips the lint pass from default file discovery to an
explicit include-list (`resolveLintIncludePaths` → `shouldIncludeExplicitLintPath` in
`dist/index.js`), which silently drops ~half the monorepo's real source from linting —
verified: `packages/hooks` 34 → 0, `token-cache` 56 → 0, full repo 2258 → ~1164. The
picomatch patterns are innocent (they correctly do NOT match `src/*.ts`); the mere
presence of the key changes discovery. Build artifacts are gitignored (git file listing
never sees them) and `test-noise`-tagged rules already auto-suppress in non-production
files, so `ignore.files` was redundant as well as destructive. Suppress specific findings
with `ignore.overrides` (file + rule) or `rules` (per rule) instead.

## Baseline (full scan, telemetry off, 2026-06-15, react-doctor 0.5.5)

**2258 diagnostics — 289 error / 1969 warning — across 365 files / 18 projects.**

By category: Maintainability 1379 · Performance 556 · Bugs 279 · Accessibility 28 · Security 16.

Top rules: `react-compiler-no-manual-memoization` **1211** · `react-hooks-js/refs` 108 ·
`async-await-in-loop` 91 · `react-hooks-js/todo` 69 (React Compiler "unsupported syntax"
bail-outs) · `rerender-lazy-ref-init` 61 · `js-combine-iterations` 57 · `exhaustive-deps`
55 · `no-event-handler` 55 · `unused-dev-dependency` 54 (DISABLED) · `only-export-components` 51 ·
`set-state-in-effect` 49 · `no-adjust-state-on-prop-change` 48.

Error-severity rules (block-eligible): `refs` 108 · `todo` 69 · `set-state-in-effect` 49 ·
`no-adjust-state-on-prop-change` 48 · `immutability` 5 · misc 10.

By package (total / err): file-explorer-ui 720/104 · ui 377/23 · db-explorer 225/40 ·
app-shell 160/17 · preferences 132/12 · file-explorer-hooks 124/20 · vector-management 122/18 ·
desktop 105/5 · db 101/18 · token-cache 56/12 · web 43/4 · file-import 38/9 · hooks 34/7 ·
embeddings 8 · file-explorer 7 · test-utils 5 · context-actions 1 · docs 0.

> With the shipped config (deslop dependency rules disabled, NO `ignore.files`), the
> working backlog is **2199** (2258 − 59 dependency false-positives). The ~41 test-file
> findings remain (react-doctor handles `test-noise` rules natively); address or
> `ignore.overrides` them as they surface per package.

## Stacked-PR remediation roadmap

Each PR stacks on the previous. Discipline: **red-green** — confirm the issues fire
(`react-doctor <scope> --category X --verbose`), fix, confirm they clear, and keep the full
`build + lint:ci + typecheck + unit` suite green per AGENTS.md. Commit in small batches.

- **PR 1 — Foundation (#1228, DONE).** Pin react-doctor; `doctor.config.ts`; CI workflow;
  `doctor` script; knip relationship documented; AGENTS.md section. No source changes.
- **PR 2 — Dead code (#1229, DONE).** Broke the preferences store ↔ settings-test-runtime
  circular import (extracted the shared store-name const). Disabled `deslop/unused-export`
  + `unused-type` to mirror knip's `exports: off`. deslop findings → 0.
- **PR 3 — Security + Accessibility (DONE).** Triaged all 34 real-source findings: only
  **1** was genuine (vector-status missing label — fixed). The other 33 were
  false-positive / intentional custom widgets / test fixtures / already `biome-ignore`d.
  Disabled the `Accessibility` + `Security` categories (a11y duplicates biome; security
  was 100% FP). Categories → 0.

### Recalibration (after the PR 3 audit)

The PR 3 audit established that react-doctor's findings on this mature, biome-linted
codebase are **~97% false-positive / intentional**. Strategy for the rest: **triage +
tune** — fix genuine issues, config-disable FP-prone/redundant rules — and **prioritize
the React-Compiler-correctness rules**, which are react-doctor's unique value over the
existing biome + knip setup. Do NOT hand-suppress every finding.

- **PR 4 — React-Compiler correctness (PRIORITY).** `react-hooks-js/refs` 108,
  `react-hooks-js/set-state-in-effect` 49, `react-hooks-js/todo` 69 ("compiler can't
  optimize this" bail-outs), `immutability`, `purity`, + `no-adjust-state-on-prop-change`
  48. These are real "your component silently isn't being memoized / has a hooks bug"
  signals biome/knip don't have. Triage per package; fix genuine, config-tune FP.
- **PR 5 — Genuine Bugs** (`effect-needs-cleanup`, `exhaustive-deps`, `no-event-handler`,
  `no-children-prop`, `no-derived-state`, …) — keep only the real ones; many overlap biome.
- **PR 6 — Performance (lighter pass)** (`async-await-in-loop` 91, `rerender-lazy-ref-init`
  61, `js-combine-iterations` 57, …) — fix clear wins; many are stylistic.
- **PR 7 — Maintainability non-memo** (`only-export-components`, `no-giant-component`,
  `no-barrel-import`, …) — triage; expect a high FP/stylistic rate.
- **HELD — `react-compiler-no-manual-memoization` (1211).** Separate go/no-go (user
  decision). The repo runs the React Compiler deliberately; stripping 1211 manual memos is
  a large, opinionated refactor. Options: per-package removal (trust the compiler, keep
  memo that guards non-React work / external-store identity), OR disable the rule via
  `rules: { 'react-doctor/react-compiler-no-manual-memoization': 'off' }` if the team
  considers the manual memoization intentional.

## Commands

```bash
pnpm doctor                                  # full local scan (telemetry off via config)
npx react-doctor . --scope changed --verbose # only new issues vs base
npx react-doctor . --category Security --verbose
npx react-doctor why <file>:<line>           # explain why a rule fired
pnpm knip                                    # dependency dead-code (retained)
```
