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

- **PR 1 — Foundation (this PR).** Pin react-doctor; `doctor.config.ts`; CI workflow;
  `doctor` script; knip relationship documented; AGENTS.md section. No source changes.
- **PR 2 — Dead code (deslop).** Verify each unused file/export/type + the circular dep is
  truly dead (deslop runs without per-package entry points → confirm before deleting), remove.
- **PR 3 — Security (16) + Accessibility (28).** Small, high-value; recount on real source.
- **PR 4 — Bugs: errors first** (`no-adjust-state-on-prop-change` 48, `effect-needs-cleanup`,
  `no-eval`, …) **then warnings** (`exhaustive-deps`, `no-event-handler`, `no-children-prop`,
  `no-derived-state`, …). Split by package if large.
- **PR 5 — React-hooks-js correctness** (`refs` 108, `todo` 69, `set-state-in-effect` 49,
  `immutability`, `purity`). React Compiler bail-outs; high value. Split by package.
- **PR 6 — Performance** (`async-await-in-loop` 91, `rerender-lazy-ref-init` 61,
  `js-combine-iterations` 57, `async-defer-await`, `js-tosorted-immutable`, …).
- **PR 7 — Maintainability (non-memo)** (`only-export-components` 51,
  `no-react19-deprecated-apis` 25, `no-giant-component`, `no-barrel-import`, `no-multi-comp`).
- **PR 8+ — `react-compiler-no-manual-memoization` (1211).** Largest + most opinionated.
  Split per package (file-explorer-ui, ui, db-explorer, …). Trust the React Compiler, but
  KEEP manual memo where it guards non-React expensive work or external-store identity
  (verify behavior + tests per slice). If the team decides manual memo is intentional in
  some areas, the escape hatch is `rules: { "react-doctor/react-compiler-no-manual-memoization": "off" }`
  scoped via `ignore.overrides` rather than mass edits.

## Commands

```bash
pnpm doctor                                  # full local scan (telemetry off via config)
npx react-doctor . --scope changed --verbose # only new issues vs base
npx react-doctor . --category Security --verbose
npx react-doctor why <file>:<line>           # explain why a rule fired
pnpm knip                                    # dependency dead-code (retained)
```
