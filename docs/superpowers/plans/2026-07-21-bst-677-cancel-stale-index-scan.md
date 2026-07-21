# BST-677 — cancel stale Workspace Index scans

## Goal

Make a Workspace Index policy change supersede the active scan so the replacement
policy owns traversal and visible progress.

## State and ownership

- The preferences store is the source of truth for the selected policy.
- `WorkspaceCollectionSyncProvider` restarts the active service run when that
  policy changes.
- `WorkspaceCollectionSyncService.runId` plus its `AbortController` own the live
  scan/import generation.
- A deleted service/provider aborts in-flight work; no new persistent state is
  introduced.

## Red / green proof

1. Add a red service test where a Full-root import emits delayed progress after
   a Balanced replacement run completes; prove the stale callback overwrites the
   replacement status.
2. Gate scan/import progress and trailing flushes on current run ownership.
3. Prove a provider Full-root → Balanced change aborts the first signal and the
   next traversal uses Balanced exclusions.
4. Distinguish expected enhanced-import cancellation from genuine catastrophic
   failure in logs.
5. Run focused suites, the repository gate after the parent PR merges, and exact
   Desktop CDT against a Python-venv workspace.

## Scope boundary

Do not redesign filesystem adapters. Native `readdir` calls already executing
cannot be preempted; cancellation prevents processing their results and prevents
new descendant reads. A cross-adapter abortable enumeration API would be a
separate architecture change.
