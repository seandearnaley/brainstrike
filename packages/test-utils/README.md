# @brainstrike/test-utils

Centralised testing helpers for Vitest, React Testing Library, and worker-based scenarios.

## Purpose
- Share async helpers, rendering utilities, and factory functions across packages.
- Provide consistent Vitest setup/teardown logic via `vitest.setup.ts` and `vitest.base.ts`.
- Support Electron and worker-specific tests with environment-safe wrappers.

## Key exports
- Async helpers from `async.ts` (`waitForCondition`, `flushPromises`, etc.).
- Renderer utilities from `render-with-providers.tsx` for component tests.
- Factories such as `createFileNode` in `factories/file-node.ts`.
- Worker harnesses from `worker.ts` to simplify testing queue workers.
- Electron utilities from `electron.ts` for stubbing IPC bridges.
- Re-exported Vitest config helpers via the `./vitest.base` and `./vitest.setup` entry points.

## Common commands
- `pnpm run build` – produces ESM/CJS bundles and declaration files for all helpers.
- `pnpm run test` – runs Vitest, including mutation-ready suites when paired with Stryker.
- `pnpm run type-check` – runs TypeScript in strict mode to ensure helper typings stay accurate.
- `pnpm run mutation` – executes Stryker for mutation analysis (see project settings in `stryker.config.js`).

## Setup notes
- Requires Node.js 22+. React 19 typings are bundled to match the app packages.
- Consuming packages should import from the top-level entry (`@brainstrike/test-utils`) rather than deep paths so bundlers can tree-shake correctly.
- For CI-specific test configuration (headless Electron, retries, etc.), refer to [`docs/electron-headless-testing.md`](../../docs/electron-headless-testing.md).
