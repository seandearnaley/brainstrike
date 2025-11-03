# @brainstrike/platform-utils

Runtime detection helpers used to branch logic between browser and Electron environments.

## Purpose
- Detect whether code is executing in an Electron renderer, Electron main process, or the browser.
- Provide lightweight utilities that other packages can rely on without importing Electron-specific APIs directly.

## Key exports
- `detectPlatform()` – returns `'electron'` or `'web'` by inspecting `window.process` and `process.versions.electron`.
- `Platform` type alias for the supported runtime strings.

## Common commands
- `pnpm run build` – generates ESM/CJS bundles and type definitions via `tsup`.
- `pnpm run test` – runs Vitest using `jsdom` to simulate browser globals.
- `pnpm run type-check` – executes TypeScript across runtime and test projects.
- `pnpm run lint` – leverages the workspace lint script to keep formatting consistent.

## Setup notes
- Requires Node.js 22+ and expects no Electron globals when running in pure web tests.
- Consumed heavily by [`@brainstrike/file-system`](../file-system/README.md) and [`@brainstrike/storage`](../storage/README.md); update those packages if you add new platform identifiers.
- For guidance on how the runtime detection integrates into desktop flows, see [`apps/desktop`](../../apps/desktop/README.md).
