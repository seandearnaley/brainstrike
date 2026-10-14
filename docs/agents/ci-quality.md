# Validation and delivery

CI is disabled due to cost; validation must run locally. Hosted workflows and
automated reviews require explicit owner authorization. Their preserved YAML is
reference material, not a request to dispatch them.

## Choose useful checks

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

## Finish without an endless campaign

Batch related corrections and retest the affected behavior. Reuse passing checks
when their relevant source, runtime, artifact and environment inputs are unchanged;
a different commit SHA alone is not a reason to repeat everything. Broaden testing
for an identified risk or unresolved failure, then stop when the agreed acceptance
is demonstrated. Avoid loading a machine beyond its useful test capacity.

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
Historical explanations remain in `ci-quality/` and Git history; they are not
additional gates or mandatory reading.
