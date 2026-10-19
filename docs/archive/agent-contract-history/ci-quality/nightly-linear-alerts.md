# Nightly Linear alerts — evidence

Supports `docs/agents/ci-quality.md` § "Nightly failures file one Linear issue
per workflow" (BST-1915), now one per failing test (BST-2189). Read this before
changing `nightly-linear-alert.yml`, `scripts/notify-linear-nightly.mjs`,
`scripts/lib/nightly-test-results.mjs`, or a workflow's `notify-linear` job or
nightly results upload.

## Why

The four GitHub-Issue nightly notifiers (web E2E, desktop E2E, nightly coverage,
performance) filed #2076, #2077, #2284 and #2074. Each accumulated 48-65
comments and none was ever actioned: work in this repository is triaged in
Linear, not in GitHub Issues. `mcp-verification.yml` and `knip.yml` alerted
nowhere, so a red nightly in either went unseen.

## Lifecycle

BST-2189 replaced one issue per workflow with one issue per failing test.

- Each nightly Playwright run writes a JSON report to
  `$RUNNER_TEMP/nightly-results/<results job>/<part>/`. A part is one job
  instance: each Desktop regression shard (`shard-N`, declared to Notify Linear
  through its `parts` input), otherwise `main`. An `always()` step records the
  job's own `job.status` there, and the job uploads the directory as
  `nightly-results--<job>[--<part>]` on every run. The web lane sequence also
  writes `<lane>.unreported` for a lane that failed without a report. Notify
  Linear downloads them, and `scripts/lib/nightly-test-results.mjs` reads them
  into tests: workflow, repository spec path and full title.
- A failing test gets its own issue, `Nightly red: <workflow> › <spec> › <title>`.
  A test that passed only on retry gets `Nightly flaky: …` and the `flaky` label,
  and stays in the gate. Both are labelled `nightly-alert`, `area-ci`,
  `needs-human`, assigned to the key's owner, `Todo`, priority High.
- Deduplication reads two markers in the description, never the title:
  `nightly-workflow:<digest>` finds a workflow's open issues and
  `nightly-identity:<digest>` names one test. A retitled issue is still found.
- A further failing or flaky night comments on that test's issue. A night the
  test passes comments `Recovered: <run URL>` on that issue alone, once until its
  next red night. A green workflow recovers every open issue it owns; a test that
  did not run on a red night is left alone.
- A red job is judged part by part, so a sibling shard's failing test never
  explains another shard. These go to one workflow-level issue,
  `Nightly red: <workflow>`, which lists each: a red part with no failing test
  of its own, an expected part that uploaded nothing or recorded no status, a red
  job whose parts all report success, an unreported lane, a run error such as a
  global timeout, and any report that cannot be read. It recovers the first
  night without one (Codex review on #3989).
- Workflows that upload no results (Test, Nightly Coverage, Knip and the rest)
  file every red night on their workflow-level issue.
- The script never closes or reopens an issue. A human closes it, and a failure
  after that opens a new one. Two open issues for one identity, or an issue with
  the workflow marker but no identity marker, fail the run before any write.
- Issues filed before BST-2189 carry no marker and are not found again; close
  them by hand.

## Owner-only setup

`gh secret set LINEAR_API_KEY` with a Linear personal API key (read and write).
Agents never set or read it. Scheduled workflows run from the default branch,
so this takes effect when the integration branch lands on `main`; the first
scheduled run after the secret is set is the live check.
