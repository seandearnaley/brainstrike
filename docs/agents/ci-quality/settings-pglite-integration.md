# Settings PGlite integration lane

Supports `ci-quality.md` § "A worker with a blocked event loop is killed and named"
and the existing root `AGENTS.md` env-sensitive test partition.

## 2026-09-28 — dependency qualification (BST-1856)

DOM upgrade PR #3361, head `0db6c24d9e008fac8989eecbac1602a6a060a857`,
failed required Unit (rest), job `108831053824`, in Test `36392233604`.
The settings bulk Undo suite's `beforeEach` timed out after Vitest's default
10 seconds while creating a real PGlite engine and running real migrations.
The Undo assertion had not run; 1,018 other settings tests passed.

The suite used a plain `.test.tsx` suffix and ran inside the cacheable `test`
task. Real WASM boot depends on runner load and belongs in the existing uncached
`test:integration` phase, whose workflow concurrency is already bounded at two.
It now uses `.integration.test.tsx`, and the package scripts partition that suffix
without changing the workflow or dropping either test. The integration config
inherits aliases, jsdom, globals, reporters and timeout setup; its own coverage
is disabled and its include selects only canonical integration test extensions.
The single-process coverage script still runs the complete suite.

Both effective configs lead with the existing event-loop watchdog. The guard
lists those two lanes and the paired override tests exercise the new package.
The real database setup has a 30-second hook budget; assertion and teardown
timeouts remain unchanged. The two tests still create isolated full-extension
engines, apply production migrations, prove all-row Undo and newer-row protection
against actual SQL, and close their owned engines. No mock replaces this proof.

Renaming alone made the existing cache-partition guard fail for settings-ui.
Registering the new lane without its leading watchdog also failed the real
effective-config guard. Both failures are preserved; the complete repair must
pass those guards, real integration tests, remaining unit tests and required CI.
Reference: [Vitest hookTimeout](https://vitest.dev/config/hooktimeout).
