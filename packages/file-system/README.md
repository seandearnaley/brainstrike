# @brainstrike/file-system

Platform-aware file system abstraction used by workers, the desktop shell, and browser integrations.

## Purpose
- Provide adapters for Electron, browser File System Access API, and mock implementations for tests.
- Normalise error handling and metadata around `IFileNode` (re-exported from [`@brainstrike/types`](../types/README.md)).
- Offer factories and utilities that choose the right adapter depending on runtime, pairing with [`@brainstrike/platform-utils`](../platform-utils/README.md).

## Key exports
- Adapter implementations from `adapters/*` (`createElectronFileSystemAdapter`, `createWebFileSystemAdapter`, `createMockFileSystemAdapter`).
- `createFileSystemAdapter` factory that selects an adapter based on runtime hints.
- Error helpers (`FileSystemError`, `isFileSystemError`) from `errors.ts`.
- Type contracts for file handles, directories, and enumerations from `types.ts`.
- Utility helpers in `utils.ts` for path resolution, tree traversal, and platform detection.

## Common commands
- `pnpm run build` – emits ESM/CJS bundles and declaration files.
- `pnpm run test` – runs Vitest with optional Electron mocks; supports mutation testing via Stryker.
- `pnpm run type-check` – validates runtime and test TypeScript projects.
- `pnpm run mutation` – executes Stryker for mutation coverage when validating adapter resilience.

## Setup notes
- Requires Node.js 22+; Electron-specific tests expect the version pinned in `devDependencies`.
- The Electron adapter depends on `@brainstrike/platform-utils` to detect runtime—ensure both packages are built together when testing desktop flows.
- When targeting browser environments, confirm that permissions for the File System Access API are granted before invoking the web adapter (see usage patterns in [`apps/web`](../../apps/web/README.md)).
