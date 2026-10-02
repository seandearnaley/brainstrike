# Nightly Linear alerts — evidence

Supports `docs/agents/ci-quality.md` § "Nightly failures file one Linear issue
per workflow" (BST-1915). Read this before changing `nightly-linear-alert.yml`,
`scripts/notify-linear-nightly.mjs`, or a workflow's `notify-linear` job.

## Why

The four GitHub-Issue nightly notifiers (web E2E, desktop E2E, nightly coverage,
performance) filed #2076, #2077, #2284 and #2074. Each accumulated 48-65
comments and none was ever actioned: work in this repository is triaged in
Linear, not in GitHub Issues. `mcp-verification.yml` and `knip.yml` alerted
nowhere, so a red nightly in either went unseen.

## Lifecycle

- One open issue per workflow, titled `Nightly red: <workflow>`, labelled
  `nightly-alert`, `area-ci`, `needs-human`, assigned to the key's owner, `Todo`,
  priority High.
- Red with none open creates it; red with one open comments; green with one open
  comments `Recovered: <run URL>`; green with none open does nothing.
- The script never closes or reopens an issue. A human closes it, and a red
  night after that opens a new one. Two open issues for one title fail the run.

## Owner-only setup

`gh secret set LINEAR_API_KEY` with a Linear personal API key (read and write).
Agents never set or read it. Scheduled workflows run from the default branch,
so this takes effect when the integration branch lands on `main`; the first
scheduled run after the secret is set is the live check.
