# Guarded Windows generation release

Supports the root-ownership release rules in `../state-store.md`.

## 2026-10-05 — BST-1941

Windows host-lease qualification observed an `EPERM` from the generation release
rename. Subsequent isolated and broader instrumented campaigns passed; no handle
leak or antivirus/sharing cause was proved, and reproduction was stopped. The
owner approved this narrow extension after an independent read-only GO review.

The canonical `fs-retry.mjs` previously covered writer blob rename/unlink. Release
now reuses that unchanged primitive on Windows: its default 20 attempts and
`EPERM`/`EBUSY`/`EACCES` whitelist, with 1, 2, 4, …, 64 ms backoff (895 ms total).
Acquisition, pruning, reset removal and caller deadlines remain unchanged.

Every attempt validates token, PID, start time, host, root, unreleased payload and
newest generation before renaming the same fsynced, closed temp. Rename remains
the sole publication point. Exclusive open establishes temp cleanup authority;
preparation/publication failure closes any retained descriptor and removes only
that temp. An aggregate retains the original failure, cleanup failures and temp
path when cleanup fails. Acquisition's separate temp helper is unchanged.

Authority errors inside the retry callback are classified as the terminal
`LOCK_RELEASE_AUTHORITY` code, then the original cause is rethrown. A filesystem
read/listing `EPERM` therefore cannot become a rename retry. The detached
`releaseRetryStats` snapshot is cumulative per lock and uses the helper's existing
operation accounting: `maxAttempts` includes an attempted authority validation,
including one that prevents rename; `codes` identifies that abort separately.
`retries` and `retried` count only eventual-success operations. A persistent
20-attempt failure records 20 errno codes, `maxAttempts=20`, `failures=1`, and zero
eventual-success retries. Preflight/preparation and POSIX do not enter the helper.

`m0-lock-release.test.ts` injects deterministic faults into the actual filesystem
boundary while using real generation/temp bytes. It covers each whitelist code,
exhaustion, every identity field, newer/missing authority, read/listing/corruption
errors, preparation/cleanup errors, exclusive-open failure and repeat/POSIX
release. Existing generation-contention tests are retained. These simulated
Windows controls on macOS do not qualify actual Windows filesystem behavior or
diagnose the historical incident. Actual Windows qualification remains separate.

CI is disabled due to cost; validation must run locally.
