# Local-only validation — evidence

Supports `docs/agents/ci-quality.md` § "PR CI FLOW" and § "Review and CI budget".

## Cloud CI shutdown (2026-10-02)

The owner explicitly instructed agents to disable every Brainstrike workflow
and use local validation because cloud CI costs are unaffordable. This supersedes
older instructions requiring exact-head hosted checks or automated reviews.

The September Ubicloud invoice totals $704.41 after a $2.50 credit: 168,359
premium-4 minutes, 16,596 premium-2 minutes, and 111 standard-4 minutes. The actual
account had Premium Runners enabled despite the workflow's standard labels.
Premium was disabled in the Ubicloud console, which confirmed the change.
At unchanged minutes, standard list rates would have produced approximately
$439.42; that comparison is not a runtime or future-spend forecast.

A GitHub API audit of September 29 returned 922 workflow runs, including 217
Test runs (185 PR events and 32 main pushes). Only seven runs had additional
attempts. The principal volume came from repeated full pipeline execution for
many changes, not a widespread rerun loop. GitHub job timing is not Ubicloud's
billing clock and is not an exact invoice reconciliation.

All 15 workflows were disabled individually, and repository Actions permissions
were set to `enabled: false`, protecting against execution of existing and future
workflow definitions. Two cancelable queued Test runs were canceled. Six old
unfinished records rejected cancellation with HTTP 409; the Ubicloud dashboard
showed no active runners and zero allocated/requested vCPU. Those records are
not claimed canceled. The default and integration/architecture-reset rulesets
lost only their required-status-check rule; all other rules remained intact.

The YAML definitions and local validation scripts are preserved so the existing
`pnpm check` plan can continue to exercise the established checks. Comments in
every workflow, root instructions, README, and the PR template make the shutdown
and the requirement to report actual local evidence visible to contributors.

Re-enabling cloud CI requires a new explicit owner instruction. No provider
migration, default-account setting, automated reviewer, or green local run can
supply that authorization.
