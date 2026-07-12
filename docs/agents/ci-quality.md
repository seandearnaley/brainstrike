# CI & Quality Gates: PR Flow, React Doctor

> Extracted from AGENTS.md (2026-07-12). Read before changing workflows, doctor.config.ts, or knip config. Keep updated with the code.

## PR CI FLOW

Pull requests use plain GitHub Actions workflows. There is no custom planner,
no generated CI artifact, no CI routing labels, and no local command registry.

Rules:
- Do not add CI labels.
- Do not commit generated CI proof artifacts.
- Do not reintroduce the removed custom proof/planner commands or any custom
  planner script.
- Required PR checks should be the always-present checks from `.github/workflows/test.yml`.
- Web and desktop E2E smoke workflows run on every PR.
- Full web and desktop E2E regression runs on `schedule` or explicit
  `workflow_dispatch`.
- Pushes to `main` run static, unit, build, web smoke, and desktop smoke.

### @vitest/runner teardown patch (pnpm patch)

`patches/@vitest__runner@4.1.9.patch` (wired via `patchedDependencies` in
`pnpm-workspace.yaml`) fixes a vitest-internal flake: the runner throttles
task-update RPCs with a 100ms `setTimeout` that is never cancelled at the end
of a run. Under loaded CI runners that stray timer can fire after worker-state
teardown and crash with "Vitest failed to access its internal state" as an
unhandled error — every test passes but the run exits 1 (CI run 29183123865,
file-explorer Unit job). The patch adds a `cancel()` to the throttle and calls
it from `finishSendTasksUpdate` (newly exported). Regression guard:
`packages/test-utils/__tests__/vitest-runner-throttle-teardown.test.ts` — it
fails loudly if a vitest bump drops the patch. When bumping vitest, re-apply
the patch (or verify upstream fixed the throttle) before deleting it.

---

## REACT DOCTOR (LINT + DEAD CODE)

`.github/workflows/react-doctor.yml` runs **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.7.1`) on every PR and on push to `main`. It supersedes running standalone knip in
CI: React Doctor performs knip-style dead-code analysis (the bundled `deslop` engine) **and**
~250 React/JS lint rules (Security / Bugs / Performance / Accessibility / Maintainability).
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`.

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs.
- **knip is retained, NOT replaced.** `deslop` is not knip: it reads knip's `entry`/`ignore`
  (only from strict-JSON `knip.json` or `package.json#knip`, never `knip.jsonc`) but ignores
  knip's `ignoreDependencies` and has no per-dependency allowlist. So `deslop/unused-dependency`
  + `deslop/unused-dev-dependency` are disabled in `doctor.config.ts`, and `pnpm knip`
  (driven by `knip.jsonc`, with the curated false-positive allowlist) stays the dependency auditor.
- **Never set `ignore.files`** (verified against 0.5.5, re-verified against 0.7.1). A non-empty `ignore.files` flips
  the lint pass to an explicit include-list and silently drops ~half the monorepo's real
  source from linting (e.g. packages/hooks 34 → 0). Build artifacts are gitignored (never
  listed) and test-file noise is handled natively (`test-noise`-tagged rules auto-suppress
  in non-production files). Suppress findings via `ignore.overrides` / `rules`, not files.
- **`Accessibility` + `Security` categories are OFF.** a11y is already enforced by the
  biome a11y rules (and react-doctor can't read `biome-ignore`, so it re-flagged every
  documented exception + custom ARIA widget — an audit of 28 findings found 1 genuine
  gap). Security produced 0 genuine issues across 6 real-source findings; secret detection
  stays covered by the lefthook `secrets-scan`. react-doctor's unique value here is its
  React-Compiler-correctness rules (`react-hooks-js/*`, `react-compiler-*`) + dead-code,
  which is where remediation effort is focused.
- **`react-compiler-no-manual-memoization` is OFF.** Manual `useMemo`/`useCallback`/
  `React.memo` is intentional here (guards non-React work, external-store identity,
  referential stability for consumers outside the compiled tree). The rule fired 1211× (54%
  of the original backlog) demanding removal — disabled per team decision.
  `react-hooks-js/preserve-manual-memoization` stays ON (it protects memo the compiler needs).

Local: `pnpm doctor` (full scan, telemetry off via config) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

---


