# The `__vitest_worker__` mutation guard — evidence

Supports `docs/agents/ci-quality.md` § "The `__vitest_worker__` mutation
guard" (BST-591, BST-592, BST-1690). Read this when every test passes but
Vitest exits 1 with `Vitest failed to access its internal state`, before
proposing a pnpm patch on a test-tooling dependency, or before removing the
Stryker Vitest-runner patch.

The "every test passes but vitest exits 1" flake (`Vitest failed to access its
internal state` thrown from a stray 100ms task-update `Timeout`, first seen in
CI run 29183123865, root-caused in BST-591) was caused by TEST CODE deleting
the `__vitest_worker__` global — a file-explorer coverage test did this to
simulate a non-test runtime. Vitest's task-update throttle timer is
legitimately armed mid-run; if it fires while that global is absent, the
worker crashes with an unhandled error. The window only collides under
event-loop starvation, so the flake surfaced in loaded full-graph/CI runs and
never in isolation. A pnpm patch on `@vitest/runner` that cancelled the timer
at end-of-run shipped 2026-07-12 and was later shown to be a placebo (an
end-of-run stray timer no-ops on already-flushed packs); it was removed in
BST-592. Dependency fixes normally belong upstream or in supported configuration.
The user-authorized exception among test tooling is `@stryker-mutator/vitest-runner@10.0.0`
(BST-1690): carry upstream [PR #6220](https://github.com/stryker-mutator/stryker-js/pull/6220)
as a tracked pnpm patch until a compatible release ships. Vitest 5 joins full
test names with ` > `; the runner and sandbox must use that same separator
for report IDs, per-test coverage, and filtered mutant runs. Keep mutation
thresholds and `perTest` coverage unchanged. Remove the patch when upgrading
to a release containing the fix, after re-running the mutation lanes.
The installed-package regression in
`scripts/__tests__/stryker-vitest-5-compatibility.test.mjs` must kill every
fixture mutant and attribute it to the nested test; a successful dry run alone
does not prove compatibility. This exception does not reinstate the ineffective
Vitest teardown patch or permit mutating Vitest worker globals.

Regression guard: `scripts/verify-no-vitest-worker-mutation.mjs` (test:
`scripts/__tests__/vitest-worker-global-mutation.test.mjs`, run in the Static
job via `pnpm test:scripts`) forbids `delete`/`Reflect.deleteProperty`/
assignment/`vi.stubGlobal` of `__vitest_worker__` in any test file under
`packages/` or `apps/`. To exercise "not running under a test framework"
branches, mock a detection seam instead — see
`packages/file-explorer/src/persistence/test-environment.ts`.

