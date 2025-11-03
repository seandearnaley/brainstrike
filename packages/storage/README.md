# @brainstrike/storage

Shared storage abstraction that hides platform differences between Electron, browser storage, and in-memory implementations.

## Purpose
- Provide adapters for persistent storage in Electron (`IndexedDB` + filesystem bridge), the browser (`localStorage`/`IndexedDB`), and in-memory fallbacks for tests.
- Surface a factory that selects the correct adapter based on runtime detection from [`@brainstrike/platform-utils`](../platform-utils/README.md).
- Offer typed contracts for storage operations so packages such as [`@brainstrike/file-import`](../file-import/README.md) can persist import state safely.

## Key exports
- Adapter constructors from `adapters/*` (`createElectronStorageAdapter`, `createWebStorageAdapter`, `createMemoryStorageAdapter`).
- `createStorageAdapter` factory from `factory.ts`.
- Shared types (`StorageAdapter`, `StorageKey`, etc.) from `types.ts`.

## Common commands
- `pnpm run build` – emits bundles and declarations for all adapters.
- `pnpm run test` – runs Vitest; includes Electron-specific tests for the desktop bridge.
- `pnpm run type-check` – executes TypeScript for runtime and test projects.
- `pnpm run lint` – uses the root lint workflow for formatting and style enforcement.

## Setup notes
- Requires Node.js 22+. Electron-focused tests rely on the version pinned in `devDependencies`.
- When running the Electron adapter in development, ensure the file-system bridge documented in [`packages/app-shell`](../app-shell/README.md) is initialised first.
- Pair these adapters with the factory reset expectations captured in [`AGENTS.md`](../../AGENTS.md#factory-reset-contract) to ensure persistent state is cleared correctly across platforms.
