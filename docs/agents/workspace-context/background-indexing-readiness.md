# Background indexing readiness and cancellation — evidence

Supports `docs/agents/workspace-context.md` §
"WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED".
Read before changing background-indexing readiness gating, the sync provider lifecycle, or detach-versus-cancel authority (BST-630, BST-1654).

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

**Background indexing readiness (BST-630).** The shared filesystem provider's
`isAccessLoading` and the roots registry's `rootsReconciliationSettled` own
restoration readiness. Database and runtime dependencies must also exist.
Until they settle, sync stays `waiting`; elapsed time never bypasses them.
`resolveDbRootId` still awaits each root's registration before import. The
indexer scans through the filesystem adapter rather than the rendered tree,
so tree loading and expanded-path restoration neither delay indexing nor
cancel an active pass. There is no tree-restoration grace timer. Root-access
restoration resuming, root-set changes, pause, and unmount all stop the
renderer-side sync loop, but they differ on the host-owned
`source: 'background-indexing'` backfill, and that difference is the contract
(BST-1654). Unmount — including the teardown effect re-running on plain
`service` identity churn — calls `WorkspaceCollectionSyncService.detach()`:
abort the renderer loop, drop the progress subscription, leave the durable run
alone, re-attach on the next `sync()` via `selectRecoverableBackgroundBackfill`.
A deliberate stop calls `cancel()`, which also kills the host run.

Detaching drops tracking, never cancellation authority. An explicit pause or
disable cancels in-flight `background-indexing` runs regardless of which
provider instance is mounted, so `cancel()` and the disabled `sync()` path both
enumerate `getBackfillsInFlight()` and cancel every run carrying the
`background-indexing-backfill:` request-id prefix: the detached run sits in no
instance's `activeBackfill`, and the instance that observes the stop is
typically a fresh one tracking nothing at all. Runs the prefix does not claim
are left alone, and a stop that cannot be delivered rejects rather than
reporting success. Both halves are load-bearing — satisfy one by trading the
other back and the user either loses indexing on navigation or cannot stop it.

Provider regressions cover delayed access/registry/DB readiness beyond the old
grace window, tree-only churn, and in-flight cancellation in
`packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`
— the lifecycle pair there is "leaves an in-flight background-indexing backfill
running when the provider unmounts" plus the "an explicit stop after the
provider detached from a backfill" pause/disable cases. Service-level coverage
is the `detach()` and "cancellation authority over a detached run" describes in
`packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`.
Successful root imports refresh the active collection's statistics once after
all chunking/assignment batches finish. The earlier managed-cache refresh sees
files before chunks exist; waiting for embedding completion would leave the
popover claiming current zero chunks after faster startup. The real-PGlite
large-import regression verifies 108,000 pending chunks before any embedding
worker runs. This uses the existing rollup API and background scheduler priority.

