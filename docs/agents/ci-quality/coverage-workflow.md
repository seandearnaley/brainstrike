# Coverage workflows — evidence

Supports `docs/agents/ci-quality.md` § "Coverage is a separate workflow".
Read this before merging `coverage.yml` back into `test.yml`, changing its
triggers or concurrency, letting DB share the PR coverage host, or reshaping
the nightly coverage shards. The contract holds the rules; this file is the
record of why.

In the original contract the nightly-sharding, native-alias, "why its own file"
and `cancel-in-progress` paragraphs sat at the end of the Codecov subsection;
they are collected here because they are about the workflows.

Coverage used to be a job inside `test.yml` running on every `synchronize` —
11-14 min of re-instrumentation on EVERY push. Series C R7 demoted it to once
per PR lifecycle: it runs on non-draft `opened`, `ready_for_review`, non-draft
`reopened`, or an explicit `coverage` label add. It does NOT run on
`synchronize`. `nightly-coverage.yml` remains the authoritative threshold gate;
per-PR coverage is advisory Codecov patch signal only.

When DB is directly changed, the advisory workflow isolates its coverage from
the recursive package runner. It executes the same native Vitest `1/2` + `2/2`
shard set as required Unit and nightly coverage, sequentially on the single
2-vCPU host, then uses `--merge-reports=.vitest/blob`.
Vitest 5 blob output, cleanup, counting and upload/download paths all use
`packages/db/.vitest/blob`; keep the two-blob assertion and hidden uploads.
Paired: `scripts/__tests__/nightly-coverage-sharding-contract.test.mjs`. Other affected packages retain
`--workspace-concurrency=4` and explicitly exclude DB. This boundary is
load-bearing: run 30704747207 let DB share the host with another package and a
10-second type-contract test timed out after 24 minutes. Do not widen that test
or serialize every package; keep only the PGlite-heavy DB task isolated.

Nightly package coverage uses six static GitHub Actions matrix shards plus two
native Vitest DB shards and a DB merge job. Five package shards isolate the
measured heavyweight lanes; the sixth is a negative-filter remainder, so a new
package with a `test:coverage` task is covered automatically instead of
requiring registry maintenance. Each DB row uploads Vitest's blob report under
its native `1/2` or `2/2` identity. The merge job requires exactly two blobs,
runs Vitest's own `--merge-reports` coverage union, and uploads one DB JSON tar
archive. The final `coverage` job still fails closed unless all seven package
archives (six general plus the one natively merged DB archive) are present,
restores them into one workspace, and is the only job that runs
`coverage:prepare-workspace`, `coverage:enforce`, the merged report, and
Codecov. Each shard emits its blob plus a text summary; it does not render the
unused HTML/Clover report tree. Do not replace this with a generated planner
or raise the original shared timeout: the split preserves one authoritative
threshold decision while giving slow packages independent failure and timeout
domains.

Native packages may retain a `test:coverage` alias that deliberately runs their
real addon tests without instrumentation. The artifact-completeness check
requires JSON only from coverage-producing scripts (those invoking
`--coverage`); it still fails when any instrumented package omits its artifact.
This distinction does not exempt instrumented code or relax a threshold.

**Why its own file, and why you must not merge it back into `test.yml`:** the
label trigger requires subscribing to the `pull_request` `labeled` action.
`test.yml` is the SOLE producer of all five required status checks, so if it
subscribed to `labeled`, every label add would fire it and each required job
would need an `if:` guard — reporting a `skipped` check run for every required
context. Measured on PR #1664: merges are NOT blocked (`skipped` satisfies a
required check — `gh pr view --json mergeable` returned MERGEABLE), BUT the
merge box renders the LATEST check run per context, so all five required checks
displayed as `skipping` instead of `pass`. The `codex` label is already in use,
so this would hit a real flow. Splitting the file means `test.yml` never fires
on `labeled` and green stays green. It also avoids a footgun: under the guard
design, every NEW job added to `test.yml` would have to remember an `if:` guard
or silently run on label churn.

`coverage.yml` sets `cancel-in-progress: false` deliberately — it subscribes to
`labeled` for ALL labels (GitHub cannot filter label names at the trigger
level), so an unrelated label creates a run whose job is skipped; since
workflow-level concurrency is evaluated before job-level `if:`, that no-op run
would otherwise cancel an in-flight 11-14 min Coverage run.
