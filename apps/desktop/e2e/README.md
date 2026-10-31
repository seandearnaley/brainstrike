# Desktop E2E tests

The merge queue runs the smoke, regression and packaged MCP lanes on hosted runners. Before a PR, run the specs for the feature you changed.

## Run locally

- From the repository root:

  ```sh
  pnpm build --filter @brainstrike/desktop
  pnpm --filter @brainstrike/desktop test:e2e:lane:smoke
  ```

- One spec, from `apps/desktop`:

  ```sh
  pnpm test:e2e e2e/workspace-bar.desktop.test.ts --project=regression
  ```

- Against the packaged app (local only):
  - Package it as the Native Electron Package job in [`test.yml`](../../../.github/workflows/test.yml) does, with `CSC_IDENTITY_AUTO_DISCOVERY=false`.
  - Run `BRAINSTRIKE_E2E_DESKTOP_TARGET=packaged pnpm --filter @brainstrike/desktop test:e2e:lane:smoke`.
  - The harness then launches the `release/` executable. A missing executable or any other value fails the run; it never falls back to the dev build.
- `pnpm test:e2e:ui` opens the Playwright UI; `pnpm test:e2e:debug` enables debugging.
- Lane scripts (smoke, full regression, packaged, nightly) are in [`package.json`](../package.json). Performance and background-throttling checks are explicit runs, not smoke.

## Harness boundaries

- [`playwright.config.mts`](../playwright.config.mts) and [`electron-helpers.mts`](utils/electron-helpers.mts) own launches; fixtures are described in [`fixtures/README.md`](fixtures/README.md).
- Every launch uses an isolated `userDataDir`, temporary filesystem/repository fixtures and fake credentials, away from Sean's checkout and protected profile.
- Use real disk operations where behavior needs them; only the native picker is mocked.
- Coverage limits to keep visible when reporting:
  - Native foreground focus: the `windowFocus` preload bridge is off by default; focus specs enable it.
  - Production background throttling: opt in with `BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1`.
  - Fake provider streams do not prove a real model response.
- Seed catalog and conversation state through the current host owners, not renderer SQL.
- Packaged MCP Tasks tests use a test-only conformance mode and need the packaged artifact.

## Diagnose failures

- Read the runner's artifact paths and main/renderer logs.
- Open recorded artifacts with `pnpm exec playwright show-report` or `pnpm exec playwright show-trace <trace.zip>`.
- A retry is not a diagnosis; report missing verdicts and cleanup failures.
