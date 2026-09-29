# Git inventory discovery and provenance — evidence

Supports `docs/agents/changeset-diff.md` § "Git inventory — `git-inventory-service.ts` / `-discovery.ts` / `-watcher.ts`".
Read before changing the discovery walk, the dedupe key, the snapshot cache, or provenance.

The lines below are the pre-distillation contract text, extracted verbatim.

`buildInventorySnapshot(deps, signal)`: resolve workspace roots → walk each
for `.git` entries (`walkForGitEntries`, discovery module, bounded
`maxDepth 6` / `maxConcurrency 32`, never spawns git) → dedupe by
**resolved common dir** (`resolveCommonDir`, before any spawn) → for each
unique repo, spawn `git worktree list --porcelain -z` hook-free
(`invokeGitHookFree`) and classify every worktree's containment + trust.
`createGitInventoryService` wraps this in a `GIT_INVENTORY_SNAPSHOT_TTL_MS
= 5000` cache with dirty-flag invalidation and in-flight build coalescing.
Never throws — every failure mode is a visible `errors` entry.

`provenance` is typed as `'agent-reported' | 'both' | 'scanned'`. Until W3
(BST-1390) only `'scanned'` was ever produced. `GitInventoryService` itself
still produces only `'scanned'` — the MERGE happens one level up, in
`worktree-service.ts`'s `list()`, which joins the inventory with the
`brainstrike_worktrees` ledger: a scanned worktree with a ledger row becomes
`'both'`, and a LIVE ledger row that is not on disk is reported as
`'agent-reported'` with `trust: 'unvalidated'`, `trustReason: 'missing on
disk'` — present, never dropped. Nothing downstream of the inventory may
assume `'scanned'` is the only value it can see.
