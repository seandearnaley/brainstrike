# Vitest 5 migration — evidence

Supports `docs/agents/ci-quality.md` § "Vitest 5 migration" (BST-1689). Read
this when a test depends on cross-test mock history, jest-dom matcher types
fail to resolve, or a Vitest 4 API (`.sequential`, unawaited bench `.run()`)
reappears. It names the suites that set each pattern.

Accept the default `clearMocks: true`: tests must establish their own call
history. Desktop preload specs re-import their module before each test, and
main-process lifecycle mocks retain registered handlers independently of call
history (as the real event emitter does). Module-initialization assertions must import a fresh module inside
the test after `vi.resetModules()`, as in the file-explorer-hooks logger-scope
specs; do not restore cross-test history globally. DOM test projects include `@brainstrike/test-utils/vitest-matchers`: Vitest 5
extends `Matchers<R, T>`, while jest-dom 7 still declares the old `Assertion<T>`.
The shared declaration uses Vitest's public extension interface and preserves
synchronous versus promise assertion return types; runtime matchers are unchanged.
Preserve real `import.meta.url` in app-shell: its source-boundary tests resolve
files relative to their own module, so a global mock URL invalidates the guards.
Sharding contract tests read `resolveConfig(...).test` with the Vitest 5 API.
Async assertions and bench
fixture `.run()` calls must be awaited. Serialized shared-DB suites use
`{ concurrent: false }` instead of the removed `.sequential` API.

The root aggregator references package directories, so those configs do not
inherit root options. Inline projects inherit and merge arrays in Vitest 5;
keep setup files deliberate. Stryker remains 10.0.0 (its Vitest peer is >=2).
Generated reports and attachments live under ignored `.vitest/`, while
intentional visual baselines remain trackable in `__image_snapshots__`.
