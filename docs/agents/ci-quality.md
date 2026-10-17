# Validation and delivery

Per-PR CI is off due to cost; validate locally before merge. Hosted CI runs
nightly on main and files failures to Linear (`nightly-alert`). Treat an open
`nightly-alert` issue as a red main: fix main first, before merging other work
onto it. Enabling or dispatching other workflows, and automated reviews, require
explicit owner authorization; the disabled per-PR workflows' YAML is reference
material, not a request to run them.

## Choose useful checks

`test:scripts` compares TypeScript tests and supporting fixtures on disk with the
actual canonical compiler and Effect programs. Existing omissions have exact
paths and owners in `scripts/test-program-debt.json`; admission removes those
paths. New omissions and stale debt fail the guard. Candidate eval assets keep
their explicit execution owner rather than becoming ordinary package tests.

Use judgment about the changed behavior, affected dependencies and failure risk.
Start with existing focused tests. Add tests for a real regression or meaningful
new behavior, not for documentation wording, source layout or arbitrary counts.
For user-facing changes, exercise the actual flow, including the reported failure
conditions. Mock proof covers only the mocked boundary.

Use package scripts and the existing local runner instead of assembling a second
validation system. `pnpm check:routine` is the normal broader check;
`pnpm check --full` adds the complete integration, coverage and E2E plan. Choose
the full plan for changes whose impact warrants it, especially shared runtime,
storage, security and lifecycle changes. Packaging and platform changes need proof
on the affected artifact/platform. Release and deliberate stress checks are
separate work. Docs-only changes need review and appropriate formatting/link
checks, not app tests.

Biome's dependency rule checks actual workspace manifests. The module-format-only
manifests under web/desktop E2E and desktop qualification do not own installs;
their four scoped exceptions preserve the parent app's dependency ownership.

The agent/tool quality overrides in `biome.json` enforce joined async work in
tests and explicit Promise-presence checks in lifecycle code. Use `pnpm exec
biome check <affected paths>` while editing; package lint scripts currently run
the root lane. Preserve real rejection ownership rather than adding `void` to
silence a finding. Narrow cause/import/boolean rules follow the scanner's proved
scope; TypeScript, Effect diagnostics and React Compiler checks remain separate.
Run `pnpm exec node --test scripts/__tests__/isolated/agent-quality-lint.test.mjs` when
changing these overrides: real new-file fixtures verify inclusion and semantics.
`test:scripts` runs these checkout-mutating fixtures to completion first, then
runs the other script files in parallel. Keep repository scans out of the fixture
phase so they cannot observe temporary bad files or race their cleanup.
All agent `src/__tests__` layouts, including nested `.spec.ts`, `.test.ts`, `.mts`
and `.mjs` files, enforce async assertions, Promise predicates and exhaustive
switches. The scoped rejection rule rejects literal non-Error failures while
allowing original unknown errors and abort reasons; preserve their identity.
Biome accepts explicit `void` disposal and cannot prove resource joins or lazy
Effect execution. Keep those ownership proofs in focused behavior tests.

## Finish without an endless campaign

Batch related corrections and retest the affected behavior. Reuse passing checks
when their relevant source, runtime, artifact and environment inputs are unchanged;
a different commit SHA alone is not a reason to repeat everything. Broaden testing
for an identified risk or unresolved failure, then stop when the agreed acceptance
is demonstrated. Avoid loading a machine beyond its useful test capacity.
Local unit batteries and the full check's coverage stage admit one package at a
time because package Vitest pools already size themselves from the whole host;
their internal parallelism and timeout budgets stay in their package configuration.

Keep failures visible. Investigate missing verdicts, crashes and flaky behavior;
a passing retry alone does not establish the cause. Never delete a failing test,
weaken an assertion, raise a budget or add retries just to obtain green. A
quarantine needs an explicit owner-held issue and an honest statement of the gap.
Preserve unrelated baseline failures in the report rather than silently fixing
them or expanding the PR.

## Deliver an honest result

Required acceptance must pass before merge. State the tested change/artifact,
commands and results, and any unverified platforms or behavior. Keep the summary
short; raw logs belong in artifacts, not a growing list of permanent rules.

Squash with `--match-head-commit`. Validate the candidate against current main and
verify the merged tree matches the qualified tree. If inputs change, assess and
retest what they invalidate. Normal hooks and existing checks remain in force.

Tool versions, lane membership, worker counts, thresholds and setup order are
owned by executable configuration. Consult those files when changing tooling.
Historical explanations remain in the
[archived CI notes](../archive/agent-contract-history/ci-quality/) and Git history;
they are not additional gates or mandatory reading.
