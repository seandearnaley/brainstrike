# Desktop tests

Unit and integration tests for main-process services, the renderer and their boundaries. The package scripts and Vitest configs are the source of truth.

## Commands (from `apps/desktop`)

| Command | Scope |
| --- | --- |
| `pnpm test` | Unit config; excludes `*.integration.test.*` |
| `pnpm test:integration` | Native, process and Electron-dependent tests (`scripts/run-integration.mjs`; add `--coverage` for the whole suite with coverage) |
| `pnpm type-check` | Desktop TypeScript |

- One unit file: `pnpm exec vitest run --config vitest.unit.config.mts src/__tests__/main/ipc-handlers.test.ts`.
- Unit files run in parallel forks under Node. A file that needs a DOM starts with `// @vitest-environment jsdom`.
- Files share nothing but external state: use a per-test `mkdtemp` directory and bind servers to port 0. The lane fails if a test leaves new files in this package.

## Writing tests

- Put tests beside the behavior they exercise.
- Use the `.integration.test.` suffix when a test depends on real native binaries, processes, filesystem/network behavior or wall-clock timing.
- Mock only the boundary the test isolates; use recorded runtime payloads for boundary fixtures.
- Assert observable outcomes and failures.
- Running-app flows belong in the [E2E suite](../../e2e/README.md).
