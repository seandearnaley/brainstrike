# AI Tools settings smoke lanes — evidence

Supports `docs/agents/ci-quality.md` § "Desktop Electron provisioning" — the
ruling that the AI Tools settings specs sit in both required PR smoke lanes.
Read this before removing either spec from a smoke lane or the nightly route.
The contract holds the rule; this file is the record of why and what it cost.

The AI Tools settings specs are deliberately part of both required PR smoke
lanes. Their tool category/loading-tier assertions follow the shared assistant
contract and previously drifted while every PR check stayed green. Web selects
`settings-tools-and-diagnostics.test.ts` through its suite-level `@web-smoke`
tag; desktop requires both the suite-level `@smoke` tag and the explicit
`tools-settings.desktop.test.ts` allowlist entry. Both suites also remain in
nightly regression: the web broad pass includes the suite, while desktop's
regression project excludes `@smoke` and therefore chains the dedicated
`test:e2e:lane:tools-settings-nightly` lane after its broad pass. That lane has a
two-minute Playwright budget, and the scheduled workflow has a 40-minute job
budget (30-minute broad cap plus lane and setup/build headroom). The measured
incremental local cost when this ruling was made was about 5 seconds for web and
28 seconds for desktop; the first Linux CI run after admission completed the
entire desktop smoke step in 149 seconds against its 300-second Playwright
budget. `ai-tools-e2e-pr-gate-contract.test.mjs` verifies every title has
statically resolved tags, the desktop file remains PR-allowlisted and
nightly-routed, and the pull-request E2E jobs still invoke both smoke scripts
without PR-excluding conditions.
