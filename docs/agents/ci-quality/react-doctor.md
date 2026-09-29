# React Doctor — evidence

Supports `docs/agents/ci-quality.md` § "REACT DOCTOR (LINT)" (BST-981, BST-1142,
BST-1182, BST-1273, BST-1760, BST-852). Read this before bumping the React
Doctor pin, changing `doctor.config.ts`, citing a `react-doctor/*` or
`react-hooks-js/*` rule id as a contract, or re-enabling a category. The
contract holds the rules; this file is the record of the measurements behind
them. Knip has its own record in `knip-audit.md`; the ESLint warning ratchet and
the Fast Refresh boundary rule are in `eslint-warning-ratchet.md`.

## Workflow, gate, and per-version measurements

`.github/workflows/react-doctor.yml` runs **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.9.13`) on every PR and on push to `main`. It owns React/JS lint
(Security / Bugs / Performance / Accessibility / Maintainability). Knip owns
file/dependency graph analysis in the weekly/manual audit described below.
It uses `ubicloud-standard-2`; provider allocation has no GitHub fallback.
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`
(historical: it predates `deslop`'s removal, and this section wins where they differ).

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs. The pinned
  version carries [upstream's rename-aware baseline comparison](https://github.com/millionco/react-doctor/pull/1376),
  so moving unchanged code does not reclassify its diagnostics as new. Re-checked for 0.9.13
  (2026-09-15) against upstream source, not re-run here: the `baseline-pure-rename` regression
  test is byte-identical at the `react-doctor@0.9.11` and `react-doctor@0.9.13` tags.
  `compute-diagnostic-delta.ts` also gained detector-provided identities that take precedence
  over source evidence. Across both the `react-doctor` and `oxlint-plugin-react-doctor` 0.9.13
  `dist/` trees the only detector that sets one is `duplicate-jsx-subtree`, keyed on its
  JSX-family fingerprint and occurrence count rather than a path; whether that interacts with a
  BST-981-style rename set is untested. CAVEAT (BST-981,
  2026-08-06, not re-tested since): that pairing failed on a ~200-file rename PR —
  byte-identical renamed files had their pre-existing diagnostics reclassified as new, both in
  CI and in a local `--scope changed` run. Precedent: prove pre-existence with a full scan of
  the base at the old paths, then suppress narrowly via `ignore.overrides` with a follow-up
  ticket to fix the findings and drop the override. BST-1182 completed that cleanup for the
  three assistant-ui ref mutations and removed the temporary override; the caveat remains for
  future large rename sets, not as an active exception.
  `scripts/__tests__/react-doctor-version-contract.test.mjs` keeps the local and Action pins equal
  and rejects downgrade below the 0.8.2 fix. It also pins the exact reviewed version in
  `EXPECTED_REACT_DOCTOR_VERSION`, so a bump is a three-file change: root `package.json`,
  `.github/workflows/react-doctor.yml`, and that constant.
- **Keep lint enabled when reading JSON coverage.** React Doctor's `analyzedFiles`,
  `analyzedFileCount`, and `complete` fields describe its lint pass, not dead-code enumeration.
  Passing `--no-lint` therefore reports zero analyzed files and `complete:false`; through 0.9.12
  it still scanned every project for dead code, and that output is expected, not a repository
  config or environment failure (BST-1142, verified against 0.9.11 on 2026-08-23 and upstream's
  [JSON report contract](https://github.com/millionco/react-doctor/blob/main/docs/json-report.md)).
  Re-measured at 0.9.13 (2026-09-15, `cf2d8db86`): `--no-lint` reports `analyzedFileCount` 0,
  empty `analyzedFiles`, and `complete:false` for all 23 projects while `scannedFileCount`
  totals 4360; the lint-enabled full scan reports 4360 analyzed with `complete:true` for every
  project. At the `react-doctor@0.9.13` tag the contract still defines `complete` by the
  planned lint files. At 0.9.13 `--no-lint` runs no dead-code rules (see the knip bullet). It
  still reported one `duplicate-jsx-subtree` warning: that detector is tagged `project-analysis`
  and runs outside the per-file lint pass, so it reports even with zero analyzed files.
  The root `react-doctor` script pins `--scope full` and deliberately omits `--no-lint` — at
  0.9.13 that protects lint coverage, not dead-code scanning;
  `scripts/__tests__/react-doctor-version-contract.test.mjs` guards both properties.
- **0.9.11 activated four error-severity rules that 0.9.3 did not** (measured at 0.9.11 on
  2026-08-15, BST-1273; historical — the 0.9.13 re-measurement follows).
  Measured on the same tree, same 3366 scanned files: full-scan errors go 85 → 95 while total
  issues go 641 → 594. The additions are `react-hooks-js/todo` (×4), `react-doctor/
  no-prop-callback-in-render` (×3), `react-hooks-js/refs` (×1),
  `react-doctor/effect-observer-needs-disconnect` (×1), plus one extra
  `react-doctor/effect-needs-cleanup` hit (10 → 11). `no-ref-current-in-render` (×71) and
  `no-impure-state-updater` (×4) are unchanged. All 10 are pre-existing code newly caught, so
  under `scope: changed` they join the advisory backlog rather than blocking; none sit in a
  file the bump itself touched. Concentrations to expect when burning them down:
  `root-layout-content.tsx` (all three copies) and `hooks/use-resize-observer.ts`.
  **Re-measured at 0.9.13** (2026-09-15, `cf2d8db86` — `main`, 132 commits after #3038's squash
  merge, not #3038's head `3e50c70cd`; 23 projects / 4360 files / 608 issues):
  the 85 errors are `no-ref-current-in-render` ×67, `effect-needs-cleanup` ×10,
  `no-impure-state-updater` ×4, `no-prop-callback-in-render` ×3, and
  `effect-observer-needs-disconnect` ×1. This is a larger tree than the 3366-file one above,
  so the two sets of counts are not a before/after, and 0.9.13's 85 matching 0.9.3's 85 does not
  mean the rule set reverted. Of the four 0.9.11 additions, the two `react-doctor/*` rules still
  report; the two `react-hooks-js/*` rules report nothing — see the next bullet.
- **`react-hooks-js/*` rules do not run in this repository** (2026-09-15, 0.9.13; tracked in
  BST-1760). The full scan has **zero `react-hooks-js/*` findings of any severity**:
  `react-hooks-js/todo` and `react-hooks-js/refs` are not clean, they are not loaded (the same
  `refs` compiler rule holds a 123-warning ESLint budget in `eslint-warning-baseline.json`).
  React Doctor loads `eslint-plugin-react-hooks` as `react-hooks-js` only for a project it
  detects as using the React Compiler, and all 23 projects report `hasReactCompiler:false`. The
  bump did not cause this: the detection code is identical in 0.9.11 and 0.9.13, and in an
  isolated directory holding only `apps/web`'s `package.json` + `vite.config.mts` and one
  component, 0.9.13 reports `hasReactCompiler:true` for the files before BST-1659 (#3017, which
  moved the compiler from a Babel preset to `oxc-transform-react`) and `false` for the current
  ones. #3017 is an ancestor of #3038's head, so #3038's 0.9.11-vs-0.9.13 comparison (85 → 85
  errors) already ran without the plugin. BST-1273's 0.9.11 counts of `react-hooks-js/todo` ×4
  and `react-hooks-js/refs` ×1 (2026-08-15) predate #3017's 2026-09-06 merge, which is why those
  rules were still observable then. **Unresolved:** nothing in this repository has been changed
  to restore these rules; BST-1760 tracks the decision.
- **`react-doctor/no-multi-comp` re-measured for 0.9.13** (2026-09-15). BST-1273 said not to
  bump past 0.9.11 without re-measuring it. #3038 took 0.9.13 without measuring this rule
  specifically; its full-scope 0.9.11-vs-0.9.13 comparison (85 → 85 errors, "Crowded component
  file ×7" among the new warnings) covered it only incidentally. Upstream 0.9.12
  ([#1641](https://github.com/millionco/react-doctor/pull/1641)) split the rule:
  `react-doctor/no-multi-comp` is now the strict one-component-per-file port,
  `defaultEnabled: false` at severity `warn` (`react/no-multi-comp` aliases to it), and the
  previous lower-noise policy moved to `react-doctor/no-multi-component-file`, on by default at
  `warn` and reported as "Crowded component file". The 0.9.13 full scan reports `no-multi-comp`
  ×0 and `no-multi-component-file` ×7 warnings in 2 files; no repo config sets either id, so
  neither can trip `blocking: error`. The id's occurrence count in `react-doctor/dist/` is 6 at
  0.9.11 (reproduced from the published tarball), 15 at 0.9.12 (BST-1273, not re-measured), and
  10 at 0.9.13 — a proxy, not a severity signal, and `dist/`-only: the rule itself ships in
  `oxlint-plugin-react-doctor`. Enabling `no-multi-comp`, or raising either id
  to `error`, is the change that needs a fresh multi-component scan first.

## Config invariants: ignores, categories, rule liveness

- **No broad `ignore.files` exclusions.** The old 0.5.5/0.7.1 implementation silently dropped
  roughly half the monorepo when that key was present. Upstream fixed enumeration by listing
  all supported sources before filtering (0.9.3, per `doctor.config.ts`; the 0.9.13 full scan
  analyzes all 4360 scanned files with every project `complete:true`), but Brainstrike still
  needs no whole-file ignores: build artifacts are gitignored and test-file noise is handled
  natively. Prefer the narrow `ignore.overrides` / `rules` surfaces for a proved exception.
- **`Accessibility` + `Security` categories are OFF.** a11y is already enforced by the
  biome a11y rules (and react-doctor can't read `biome-ignore`, so it re-flagged every
  documented exception + custom ARIA widget — an audit of 28 findings found 1 genuine
  gap). Security produced 0 genuine issues across 6 real-source findings; secret detection
  stays covered by the lefthook `secrets-scan`. react-doctor's unique value here is its
  React-Compiler-correctness rules (`react-hooks-js/*`, `react-compiler-*`) + dead-code,
  which is where remediation effort is focused. At 0.9.13 none of that runs here: the
  `react-hooks-js/*` rules and dead-code analysis are inactive (see the `react-hooks-js` and knip
  bullets; BST-1760 and BST-1761 track restoring them), and the only `react-compiler-*` id,
  `react-compiler-no-manual-memoization`, is off by config and, per its upstream source, active
  only when the React Compiler is detected, which no project here is. What still reports is
  React Doctor's native set: 53 `react-doctor/*` rule ids in the 2026-09-15 full scan, and all
  85 errors come from that set.
- **`react-compiler-no-manual-memoization` is OFF.** Manual `useMemo`/`useCallback`/
  `React.memo` is intentional here (guards non-React work, external-store identity,
  referential stability for consumers outside the compiled tree). The rule fired 1211× in the
  2026-06-15 baseline (react-doctor 0.5.5; 54% of that 2258-finding backlog) demanding removal —
  disabled per team decision.
  `react-hooks-js/preserve-manual-memoization` stays ON in config (it protects memo the
  compiler needs), but at 0.9.13 the `react-hooks-js` plugin is not loaded here; see the
  `react-hooks-js` bullet.
- **An unimplemented rule id is accepted SILENTLY — 0 findings means "gone" OR "clean".**
  `doctor.config.ts` emits no "unknown rule" error, so a config that believes it enabled
  (or disabled) a rule is indistinguishable from one that did not, and that rule's zero
  findings read as a passing gate. Re-proved at 0.9.13 (2026-09-15) with a deliberately
  nonexistent id: adding `'react-doctor/zz-nonexistent-rule-probe': 'error'` produced no
  warning and an identical 608-issue summary. The original example no longer holds:
  `react-doctor/only-export-components` (2026-08-09, pinned 0.9.3) was judged alias-only from a
  grep of `react-doctor/dist/` alone, where it appears as a *value* in the oxlint→react-doctor
  alias tables (`react-refresh/only-export-components` and `react/only-export-components` both
  map to it). The separately published `oxlint-plugin-react-doctor` carries a registry entry for
  the id at 0.9.11 and 0.9.13, and at 0.9.13 the rule reports ×45 warnings in the default full
  scan. That example's control — adding `rules: { 'react-doctor/only-export-components': 'warn' }`
  left counts byte-identical (149 → 149 on `packages/file-explorer-ui`) — remains a 0.9.3
  measurement, not re-run. An unchanged count could never prove absence: it is also what an
  already-enabled `warn` rule, or a rule with no violations in that package, produces. Reuse
  the nonexistent-id probe above as the silent-acceptance control. **Before citing a
  react-doctor rule id as a contract, prove it fires on a known violation** — a
  package-scoped scan returning 0 is not evidence.
  `scripts/__tests__/lint-rule-liveness-contract.test.mjs` mechanizes that proof — **for
  ESLint rules only.** It drives `new ESLint({ cwd: repoRoot })` against `eslint.config.js`,
  so it exercises **zero react-doctor rules** and confers no coverage on any
  `react-doctor/*` or `react-hooks-js/*` id, or on the legacy `deslop/*` aliases. Do not
  read a green `test:scripts` as evidence that a react-doctor id is live; that engine remains
  unmechanized, and it is the one with the silent-acceptance defect.
- **The two ids once "absent from the bundle" were a grep-scope miss; only `async-parallel` is
  proved live** (2026-08-09, #2372;
  re-measured at 0.9.11 on 2026-08-15, BST-1273; re-measured at 0.9.13 on 2026-09-15).
  `react-hooks-js/preserve-manual-memoization` and `react-doctor/async-parallel` (the rule in
  `doctor.config.ts`'s lone `ignore.overrides` entry) still appear **0 times** across
  `node_modules/react-doctor/dist/` at 0.9.13. Occurrence counts there by `grep -o | wc -l`,
  at 0.9.3/0.9.11 then 0.9.13: `only-export-components` 12 then 8;
  `react-compiler-no-manual-memoization` 10 then 7; `preserve-manual-memoization` 0 then 0;
  `async-parallel` 0 then 0. The 0.9.11 figures reproduce from the published tarball. But
  rule metadata ships in the separate `oxlint-plugin-react-doctor` package (`async-parallel`
  ×10 at 0.9.11, ×12 at 0.9.13), and the compiler rules come from `eslint-plugin-react-hooks`,
  loaded as `react-hooks-js`. Liveness at 0.9.13: **`react-doctor/async-parallel` is live** —
  the default full scan reports it ×4 in files other than `db-provider.tsx` — so the override
  targets a real rule. `react-hooks-js/preserve-manual-memoization` is registered (severity
  `error` in the plugin's compiler-rule table) but reports nothing here because the
  `react-hooks-js` plugin is not loaded (see the `react-hooks-js` bullet). Registry presence is
  not firing evidence, and no planted violation has proved this id live. The manual-memoization
  protection still exists via eslint-plugin-react-hooks' own
  `react-hooks/preserve-manual-memoization`, which is live, reporting 2 warnings, and is
  tracked in `eslint-warning-baseline.json`.

## Local commands, the script name, and CLI constraints

Local: `pnpm run react-doctor` (lint-enabled full scan, telemetry off via config) ·
`pnpm exec react-doctor . --no-supply-chain --scope full --json --no-cache` (fresh machine report) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

**The script is named `react-doctor`, not `doctor`, and the `run` is not optional.**
`doctor` is a pnpm **builtin** subcommand, so `pnpm doctor` <!-- shadowed-shorthand-example --> runs pnpm's own
environment doctor and never reaches any package script — while printing
`All checks passed with 1 warning(s)` and exiting 0, which reads exactly like a
clean react-doctor run. Because react-doctor error-severity findings are a
required PR check, that false green can be followed by a red CI. The script was
renamed in BST-852 so the collision cannot be typed by accident, and
`scripts/__tests__/pnpm-shadowed-builtin-contract.test.mjs` fails if any package
reintroduces a shadowed script name or any doc reinstates the bare shorthand.
The shadow set is empirical, not read from `pnpm help -a` — that listing omits
`doctor` (hidden yet shadowing) and lists `clean` (visible yet harmless).

Two react-doctor CLI constraints worth knowing before you script around it:

- It takes a **directory only**. A file path fails with `not a directory`, so
  per-file checks are not possible.
- It takes **exactly one** positional argument (`too many arguments. Expected 1
  argument but got 3`), so covering several changed paths means several
  invocations — do not pass a changed-file list.
