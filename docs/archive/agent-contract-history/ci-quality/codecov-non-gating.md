# Codecov statuses are non-gating — evidence

Supports `docs/agents/ci-quality.md` § "Codecov statuses are non-gating"
(settled 2026-07-26 — do not relitigate). Read this before proposing to make
`codecov/patch` or `codecov/project` block merges, or before changing
`scripts/verify-codecov-status-contract.mjs`. The contract holds the rules;
this file is the record of why.

The ruleset requires exactly five contexts — `Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E` — all produced by `test.yml`. `codecov/patch` and
`codecov/project` are NOT among them, so a failing Codecov status can never
block a merge; it only renders a red X and an `UNSTABLE` merge box.

`codecov.yml` nonetheless carried the comment *"Keep patch coverage blocking
instead"*, contradicting both `test.yml` and this document. Two sources plus the
ruleset agreed; `codecov.yml` was the outlier and was simply wrong. Resolved by
making the config match reality in Codecov's own documented way:
`coverage.status.patch.default.informational: true` — the status still posts and
still shows the percentage, it just never fails
(<https://docs.codecov.com/docs/commit-status>). `target`/`threshold` are kept
deliberately so the number remains visible.

Two independent reasons patch coverage must not gate here, both measured:

- **PR uploads are affected-only**, so patch % is systematically understated. On
  PR #2024 Codecov reported **27.86%** while the three changed source files
  measured **97.5% / 98.07% / 98.21%** locally.
- **A stacked PR has no BASE report**, so Codecov cannot compare at all and says
  so: *"Please upload report for BASE"*. `codecov.allow_pseudo_compare` (default
  true) does not rescue this — it substitutes a parent commit for skipped-CI and
  merge-commit bases, not for a branch that never uploaded a report.

The authoritative gate is unchanged: `nightly-coverage.yml` →
`pnpm coverage:enforce` (`scripts/enforce-coverage.mjs`), full unfiltered
coverage with ratcheted per-package thresholds, which opens an issue on failure.

`scripts/verify-codecov-status-contract.mjs` (run by `pnpm test:scripts` in the
Static job) enforces this. Two properties it must hold, and the first review of
it found six violations of the first:

- **Never pass vacuously.** Codecov reads `coverage.status.<type>` as a MAP OF
  CONTEXTS, so every child of an enabled status must itself be disabled or
  explicitly `informational: true`. That single rule covers the shapes that
  previously slipped through: an empty or array status block, settings written
  flat without a `default:` wrapper, a scalar context (`default: true`), an
  empty mapping, and a status-level `informational:` shorthand that is not
  documented and would have waved through a still-gating `default`.
- **Never fail a valid config.** `pnpm test:scripts` runs in the REQUIRED Static
  check, so a false positive blocks every merge — worse than the red X this
  removed. Hence `off` is matched case-insensitively (`yaml` v2 uses the YAML
  1.2 core schema, where bare `off` is the STRING `'off'`, not a boolean), and
  unknown keys under `coverage.status` are REPORTED, not fatal: Codecov
  publishes exactly `codecov/project`, `codecov/patch` and `codecov/changes`, so
  nothing else there can gate.

It also searches every location Codecov reads config from — root, `dev/`,
`.github/`, as `codecov.yml` or `.codecov.yml` — and fails if two exist, since
which one wins is undocumented and a second file could silently change the
effective config.

**Re-gating is a two-part change**: PR uploads must become complete AND the
context must be added to the ruleset. Doing one without the other re-creates the
contradiction.
