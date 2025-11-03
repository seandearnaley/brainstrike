# @brainstrike/workers

Background workers used by the apps to stream file contents and generate project reports without blocking the UI.

## Purpose
- Parallelise expensive IO (reading file contents) and summarisation tasks in a worker context.
- Provide shared worker implementations consumed by [`@brainstrike/file-import`](../file-import/README.md) and the desktop shell.
- Enforce consistent error handling with the shared types from [`@brainstrike/types`](../types/README.md).

## Key exports
- `file-content-worker` – exposes `createFileContentWorker`, which batches file reads with configurable concurrency and binary detection via [`@brainstrike/utils`](../utils/README.md).
- `report-generation-worker` – exposes `createReportGenerationWorker`, which builds summaries using either File System Access handles or adapters from [`@brainstrike/file-system`](../file-system/README.md).

## Common commands
- `pnpm run build` – compiles the worker entry points to `dist/`.
- `pnpm run test` – executes Vitest suites covering file read concurrency and report generation.
- `pnpm run type-check` – runs TypeScript in no-emit mode to ensure worker contracts stay aligned with consuming packages.
- `pnpm run mutation` – optional Stryker run for mutation testing of concurrency edge cases.

## Setup notes
- Requires Node.js 22+. Tests rely on helpers from [`@brainstrike/test-utils`](../test-utils/README.md).
- When integrating with Electron, ensure the file system adapter from [`@brainstrike/file-system`](../file-system/README.md) is initialised before starting the workers.
- Report generation expects chunked content from [`@brainstrike/file-import`](../file-import/README.md); keep those packages in lockstep when adjusting request payloads.
