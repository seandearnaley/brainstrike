# Review instructions

Claude Review (`.github/workflows/claude-review.yml`) reads this file from the
base branch, never from the pull request under review, so a change here applies
to PRs opened after it merges. Project rules live in `AGENTS.md`; this file only
says what a review reports.

## What Important means here

Reserve Important for a bug that should be fixed before merging: wrong
behaviour a user or caller will hit, lost or corrupted durable data, a reset or
recovery path that leaves state behind, a weakened security or sandbox boundary,
a silent fallback that hides a failure, a race, or a leak. A change that breaks
an owner rule in `AGENTS.md` is Important. Naming, structure and refactoring
suggestions are Nit at most.

## Cap the nits

Report at most five Nits in the initial review, and none in a follow-up.

## Do not report

- Anything the merge queue already enforces: lint, formatting, type errors,
  failing tests.
- Generated files and lockfiles (`pnpm-lock.yaml`), and recorded provider
  cassettes.
- Missing tests for a change that is only wiring, copy or styling.
- Speculation: a behaviour claim needs a `file:line` in the source you read,
  not an inference from a name.

## Always check

- New behaviour a user would notice has a test that asserts that behaviour, not
  internal call order or the text of another file.
- New durable state joins the existing reset lifecycle.
- Node-only dependencies stay out of browser bundles.
- No loosened compiler flag, disabled cache, serialized lane, or added retry or
  timer that papers over a failure.
