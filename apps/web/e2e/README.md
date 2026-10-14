# Web E2E tests

**CI is disabled due to cost; validation must run locally.** Choose meaningful
checks with [validation guidance](../../../docs/agents/ci-quality.md).

## Run locally

From the repository root:

```sh
pnpm build --filter @brainstrike/web
pnpm --filter @brainstrike/web test:e2e:lane:smoke
```

From `apps/web`, run a focused functional spec:

```sh
pnpm exec playwright test e2e/layout.test.ts --project=functional
```

Use `pnpm test:e2e:ui` or `pnpm test:e2e:debug` for interactive diagnosis.
Root `pnpm test:e2e` targets both apps; filter to web for a web-only run.
The package scripts own smoke, regression and opt-in performance selection.

## Harness boundaries

[`playwright.config.mts`](../playwright.config.mts) starts the built preview with
`pnpm start` and refuses automatic reuse of an existing server. Build first;
this is not a Vite dev-server test. Runs default to headless, including locally;
`--headed` is an explicit override. Browser projects and artifact/retry settings
are owned by that config and the shared Playwright environment configuration.

Use existing helpers under `utils/`, including app readiness and state cleanup.
Prefer accessible role/text/test IDs. Exercise the actual reported flow and
fresh-data reopen/reset behavior where relevant. Fake-provider assertions prove
only that fixture boundary; they do not demonstrate a real model response.
Use isolated browser state and fake credentials for automation.

## Diagnose failures

Read the runner's output/report paths; open a report with
`pnpm exec playwright show-report`. Inspect the first failure, app/server logs
and available traces before retrying. A port conflict or absent build needs its
own correction. Existing GitHub workflow definitions are references, not active
scheduled or automatic runs.
