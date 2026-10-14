# Retained profile reset lease

Supports `host-lease.md` sections "Root ownership" and "Desktop acquisition".

## 2026-10-03 lifecycle correction

The old reset plan closed the desktop attachment, inspected/released the root
lease, then recursively removed the profile. This admits a concurrent launcher
through a deleted lock namespace. Releasing immediately after profile clearing
also exposes a newly launched owner to the later whole-userData purge.

`acquireProfileResetLease(root)` acquires the existing authoritative RootLock
and returns an accessible owner with canonical `root`, `clearRootContents()`,
`release()` and `isReleased`. Clearing coalesces, deletes every other immediate
profile entry using real recursive filesystem removal and preserves `lock`.
It never releases automatically. Release refuses during active clearing; clear
refuses after release. An error preserves its original cause and leaves the
same guard available for retry or caller policy. Namespace ownership is checked
before/after clearing and before release. There is no new persistent namespace.

The application must first join the host manager and all query/indexer/legacy
profile writers, hold this guard through every subsequent profile, userData and
storage purge, preserve the existing lock plus its ancestor paths, and release
only after the entire destructive phase succeeds. Shared main/reset consumer
composition is separate; this change does not edit those files or claim their
acceptance. The released-generation residue contains ownership metadata and is
pruned by the next normal acquisition, not recursively deleted by reset.

CI is disabled due to cost; validation must run locally.

## RED/GREEN and local proof

The new integration suite first failed because the retained-guard API was
absent. A first fresh-checkout run after implementation lacked built state-store
and effect-kit package exports for its real child processes; all three cases
failed to load those packages. Building the actual dependency closure corrected
that setup, without changing any assertion or substituting source aliases for
the child processes. A strict Effect message on the test's numeric PID decoder
was resolved with integer decoding; all 25 host source/test files now report
zero errors, warnings or messages.

From the isolated `codex/m2-profile-reset-lease` checkout above official
integration `b04f90f5d1eb14432506e904c3ed73938a643172`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @brainstrike/host-lease... build
pnpm --filter @brainstrike/host-lease type-check
pnpm --filter @brainstrike/host-lease exec vitest run --config vitest.integration.config.mts __tests__/reset-root.integration.test.ts
```

The dependency closure and types passed. Mac arm64 passed all three cases in
one file. The Linux arm64 proof in `/profile-reset-proof` reused the existing
local Debian container dependency graph, compiled the host package with
`/workspace/node_modules/.bin/tsc -b .`, and ran:

```sh
/workspace/node_modules/.bin/vitest run --config vitest.integration.config.mts __tests__/reset-root.integration.test.ts
```

All three Linux cases passed. The contender is an actual separate Node process
using production RootLock, not a mocked lease. The during-deletion case pauses
one parent-side removal after a previous real entry is deleted; the child
refuses while the unchanged authoritative namespace remains owned. The guard
also refuses release during that pause. After profile clear it still excludes
the child until the caller explicitly releases, then fresh acquisition succeeds.
A separately injected removal exception preserves the identical error and
blocks the real contender; the retained guard retries successfully. A real
attached CLI host refuses guard acquisition while preserving both payload files
and its exact discovery record. The fixture pause/exception affect only the
parent test's filesystem call; child locking, identity and deletion remain real.

This is focused, integration-only qualification. Actual Windows execution and
the fully composed application reset remain unqualified. No M3 host/run protocol,
chat cutover, hosted CI run or unrelated broad regression was introduced.
