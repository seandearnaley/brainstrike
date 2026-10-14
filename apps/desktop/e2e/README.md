# Desktop E2E tests

**CI is disabled due to cost; validation must run locally.** Select checks with
[validation guidance](../../../docs/agents/ci-quality.md).

## Run locally

From the repository root:

```sh
pnpm build --filter @brainstrike/desktop
pnpm --filter @brainstrike/desktop test:e2e:lane:smoke
```

From `apps/desktop`, run a focused spec:

```sh
pnpm test:e2e e2e/workspace-bar.desktop.test.ts --project=regression
```

`pnpm test:e2e:ui` opens the test UI; `pnpm test:e2e:debug` enables debugging.
Smoke, full regression, packaged and stress scripts live in
[`package.json`](../package.json). Choose the affected lane; performance and
background-throttling checks are explicit runs, not default smoke acceptance.

## Harness boundaries

[`playwright.config.mts`](../playwright.config.mts) and
[`electron-helpers.mts`](utils/electron-helpers.mts) own launches. Every launch
requires an isolated `userDataDir`; temporary filesystem/repository fixtures and
fake credentials keep tests away from Sean's checkout and protected profile.
Use actual disk operations where the behavior requires them; mocking the native
picker does not mean all filesystem operations are mocked.

The default harness does not demonstrate native foreground focus or production
background throttling. It suppresses the `windowFocus` preload bridge by default;
a focus-specific spec explicitly enables it. Backgrounding checks use the
existing `BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1` launch option. Keep those limits
visible when reporting coverage. Fake provider streams do not demonstrate a real
model response.

Desktop catalog/conversation fixtures use current host owners; obsolete renderer
SQL or `mastra_threads` seeding examples do not describe the product path.
Packaged MCP Tasks tests have a separate test-only conformance mode and need the
actual packaged artifact; they do not qualify ordinary desktop storage or enable
production Tasks registration.

## Diagnose failures

Read the runner's artifact paths and main/renderer logs. Use
`pnpm exec playwright show-report` or `show-trace <trace.zip>` for artifacts that
were actually recorded. Preserve missing verdicts and cleanup failures; a retry
alone is not a diagnosis. Stop/join through the existing harness lifecycle.
