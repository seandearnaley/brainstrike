# Quiet-head admission — evidence

Supports `docs/agents/ci-quality.md` § "Quiet-head admission before PR fan-out"
(BST-597; Browser tests lane BST-994). Read this before proposing to change the
120-second hold, the fail-closed currency check, the `always()` + first-step
failure shape on gated jobs, or the browser screenshot path split. The contract
holds the rules; this file is the record of why.

Corrected after extraction (verified against `.github/workflows/test.yml`): the
Browser tests lane covers six packages — assistant-ui, db, embedding-worker,
mcp-app-host, storage, ui — where the original parenthetical listed five.

Every `pull_request` run of `test.yml` first enters the `Quiet-head admission`
job on `ubuntu-slim`, GitHub's 1-core $0.002/min runner. The gate waits 120
seconds, then reads the PR through the GitHub API and compares its current head
SHA with the immutable head SHA in this run's event payload. If they match, it
releases the complete existing job graph. If the PR advanced, the gate succeeds
with a visible notice and `admitted=false`, so the superseded SHA's seven
expensive jobs never start. Workflow-level `cancel-in-progress` remains the
first line of defense: a new `synchronize` event normally cancels the old gate
during its cheap sleep; the API comparison closes the remaining ordering race.

This is an admission delay, not CI routing. It uses no labels and never selects
a reduced test plan. The latest quiet PR head always runs the full graph,
including all five stable required contexts (`Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E`) plus both native jobs and the non-required
`Browser tests` lane (BST-994 — Vitest browser-mode suites for
db/ui/storage/assistant-ui/embedding-worker/mcp-app-host in the pinned Playwright container;
expensive enough that it keeps the same
quiet-head gate, and `quiet-head-admission-contract.test.mjs` verifies it).
Browser artifact uploads explicitly include hidden files and the resolved
attachment directories for all six browser packages; the paired screenshot
contract checks the installed Vitest configuration against the upload paths.
Vitest generated failure captures stay in ignored package-local
`.vitest/attachments/failure-screenshots` directories. Intentional `toMatchScreenshot` references are
rerouted by `@brainstrike/config` to trackable `__image_snapshots__`
directories; the db and storage projects that construct browser options
directly use the same resolver. Keep those paths separate so failure debris
cannot be committed and a new visual baseline cannot disappear from git.
Web and desktop E2E retain their `build` dependency. Push and
`workflow_dispatch` events are admitted immediately, so their behavior is
unchanged apart from the dependency edge.

The gate is deliberately fail-closed: `pull-requests: read` is its only added
permission, and a missing event SHA, missing API SHA, or API error fails the
admission job visibly instead of guessing that the run is current. Do not add a
fallback that releases work when currency cannot be established. Each of the
five required jobs uses `always()` plus an explicit first-step failure when the
admission job itself fails. This is required because GitHub otherwise skips a
job whose dependency failed, and a skipped required check can satisfy branch
protection. A normal superseded-head decision keeps the admission job successful
with `admitted=false`, so those same jobs remain skipped without allocating
their runners. Contract coverage lives in
`scripts/__tests__/quiet-head-admission-contract.test.mjs` and runs in the
Static job through `pnpm test:scripts`.

Why this exists: the measured GitHub Actions sample for 2026-07-15..19 reached
44 concurrent Linux jobs, and 513 of 1,641 `Test` workflow runs (31.3%) were
cancelled. `Test` represented roughly 92% of the modeled Actions bill. Paying
about $0.004 to hold a PR head for two minutes is materially cheaper than
starting the full fan-out during edit/push bursts.
