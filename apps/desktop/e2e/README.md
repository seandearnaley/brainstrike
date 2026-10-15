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

## Shared harness fixture exceptions

Executable `*.test.ts` specs stay below 2,000 LOC. Two shared harness modules are
explicitly documented test fixture exceptions to that budget: splitting them would
scatter one import surface across several files without making any spec smaller.

`file-explorer-selection.shared.ts` owns the desktop file-system fixtures,
persisted selection-state seeders, checkbox/expansion helpers and renderer-settle
helpers for the two selection lanes, which stay split by purpose:

- `file-explorer-selection.desktop.test.ts` - interactive selection, select-all,
  limit, expansion, and indeterminate parent/descendant behavior.
- `file-explorer-selection-restore.desktop.test.ts` - restored explicit, query,
  materialized-snapshot and manual-path selection behavior after a restart.

`embedding-worker-renderer.shared.ts` keeps the shared desktop setup, database
fixtures, host diagnostics and memory samplers for the embedding-worker renderer
lanes in one import surface.

The exception covers these harness modules only. The executable specs they serve
stay under the budget, and `runtime-host-boundary.test.ts` enforces both halves:
the per-spec line ceiling and this documentation.

## Diagnose failures

Read the runner's artifact paths and main/renderer logs. Use
`pnpm exec playwright show-report` or `show-trace <trace.zip>` for artifacts that
were actually recorded. Preserve missing verdicts and cleanup failures; a retry
alone is not a diagnosis. Stop/join through the existing harness lifecycle.
