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

## Fix agent

BST-2189 Part 2. Notify Linear's `fix_issues` output lists tonight's failing and
flaky tests' issues. Desktop E2E's `fix-nightly` job calls
`nightly-fix-agent.yml` once per issue, two at a time, on `ubuntu-latest`, the
lanes' own runner.

- `fix` holds a read-only `GITHUB_TOKEN` and no provider keys. It fails first,
  with `::error`, when `CLAUDE_CODE_OAUTH_TOKEN` is missing. It then claims the
  issue with `scripts/nightly-fix-issue.mjs`: the claim is the lock, and an issue
  already started, done or canceled skips the run. Next it runs
  `anthropics/claude-code-action`, pinned by SHA, with `/fix-nightly <issue>`
  (`.claude/skills/fix-nightly/SKILL.md`). It hands the commits off as a bundle
  artifact and posts the agent's evidence to the issue.
- `publish` pushes only `nightly-fix/<issue>-<run id>`, opens the PR with
  `Fixes <issue>` and links it on Linear. Nothing merges.
- The `ANTHROPIC_API_KEY` form of the action's credential is deliberately unused:
  the desktop app reads `ANTHROPIC_API_KEY` as a provider key
  (`apps/desktop/src/agent-client-loader.ts`), so app runs during a
  reproduction could make paid calls.
- Web E2E has no fix job yet. Its lane runs in a pinned Playwright container,
  and GitHub's docs do not define an empty `container:` for a shared job.

## Owner-only setup

`gh secret set LINEAR_API_KEY` with a Linear personal API key (read and write).
Agents never set or read it. Scheduled workflows run from the default branch,
so this takes effect when the integration branch lands on `main`; the first
scheduled run after the secret is set is the live check.

The fix agent also needs:

- `gh secret set CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` on a Claude
  subscription. Until it exists, every `fix-nightly` run fails at its first step
  and claims nothing.
- Settings → Actions → General → Workflow permissions: allow GitHub Actions to
  create and approve pull requests, so `publish` can open the PR with
  `GITHUB_TOKEN`. That job never approves.
- No GitHub App: the agent authenticates with the job's `GITHUB_TOKEN`, not the
  Claude GitHub App.
