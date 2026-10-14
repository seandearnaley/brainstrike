# Traversal policy, truncation handling, chunking re-dispatch — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "Desktop reads are mounted-root capabilities".
Read before changing the background-indexing entry policy, truncation propagation through scans, flattening, scan handles, or the chunking re-dispatch budget.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '388,507p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

The visible Explorer loads directories lazily. Recursive Workspace Index scans
use `createBackgroundIndexingEntryPolicy` from
`packages/utils/src/background-indexing-policy.ts`; keep traversal exclusions
there rather than hiding entries after the adapter has already read them.

- **Balanced (default):** prunes common dependency and generated directories
  before recursive reads, including Python `.venv`, `venv`, and `__pycache__`
  directory segments. A bare `env` remains eligible because it is also a common
  source/config directory name and the segment alone does not prove a virtualenv.
- **Full root (explicit override):** continues to traverse those Python
  directories. The Settings description calls this out so opting in does not
  silently change scan breadth.
- **Policy changes supersede active work.** Changing Balanced/Full root restarts
  the provider sync with a fresh service run and aborts the previous run. Scan
  and import progress callbacks are run-owned: after cancellation they cannot
  overwrite status from the replacement run. Cancellation is logged as an
  expected cancellation, while non-abort import failures remain error-logged
  and visible. An Electron `readdir` already executing in the OS cannot be
  preempted; the walker checks the abort before processing its result or
  scheduling any more descendants, bounding the drain to reads already in
  flight.
- **Truncated listings surface in scans; they never skip silently.** The
  registry's `'truncated'` pseudo-node (above) is Explorer-visible, but the
  recursive scan consumers must surface it too: `walkDirectoryParallel` never
  lets the marker enter the returned tree — it reports the affected directory
  through `onDirectoryTruncated`, and a walk WITHOUT that handler fails with
  `DirectoryListingTruncatedError`, including for non-root subdirectories
  whose ordinary read errors are skipped silently. Both Workspace Index scan
  modes install the handler: the full scan wires it through
  `readFullTreeWithOptions`; the scoped watcher scan recognizes the marker
  centrally in `readDirectoryWithProgress`. Each scan logs one warning and
  reports the deduped directory count as `truncatedDirectories` in the visible
  scan summary (`PreparedChangesSummary.truncatedDirectoryPaths` →
  `WorkspaceCollectionSyncScanSummary`); the content-batch phase always
  reports an empty list because only the traversal can observe truncation.
  The debug harness returns `truncatedDirectoryPaths` so coverage audits treat
  `expectedFileCount` as a floor, not an exact total.
  **Truncation also disarms absence inference — retain, never delete, on
  partial knowledge.** "Absent from a truncated listing" is not evidence of
  deletion: full-scan missing-file reconciliation skips cached rows under any
  truncated directory (root truncation protects every row), and the scoped
  directory-removal reconciliation neither prefix-wipes a removed directory
  under a truncated prefix nor exact-invalidates unobserved entries beneath
  one (watcher-authoritative exact FILE removals still invalidate). The idle
  coverage audit returns a `truncated-root` outcome — surfaced like
  `unresolved-root`: warning + visible `waiting` status, never
  `markAuditVerified`, never a recovery sync — because a fully-indexed partial
  prefix proves nothing. Paired tests:
  `parallel-directory-walker.test.ts` (report + fail-loud),
  `workspace-collection-sync-service.test.ts` (full + scoped scan summaries;
  truncation-protected invalidation), `workspace-collection-sync-scan.test.ts`
  (scoped removal guard), `workspace-collection-sync-provider.test.tsx`
  (truncated audit never verifies complete),
  `workspace-collection-sync-status-helpers.test.ts` (status row), and
  `workspace-index-debug-harness.test.ts`.
- Workspace include/exclude filters control visible-tree filtering and
  selection. They are not the Workspace Index traversal policy; do not mutate
  custom filters to implement indexing exclusions.
- **Flattening is iterative and order-preserving.** After discovery,
  `flattenFileNodes` uses an explicit LIFO stack and pushes roots and children
  in reverse so the emitted files retain recursive pre-order DFS and sibling
  order. Do not replace it with recursion or array spreading: the paired tests
  require 100,000 levels of nesting and 100,000 files in one directory to
  flatten without call-stack or function-argument overflow.
- **Scan handles retain their platform contract (BST-499).** `IFileNode.handle`
  accepts raw browser file/directory capabilities and the canonical shared
  `FileHandle`/`DirectoryHandle` descriptors. Scoped native scans construct
  descriptors directly; rebuilding a browser directory preserves its raw
  capability in `_internal` and inherits the root's durable identity. Do not
  disguise descriptors as browser capabilities with double casts. Shared type
  assertions and `workspace-collection-sync-scan.test.ts` cover both forms.
  File reads and directory traversal normalize node handles through
  `@brainstrike/file-system/file-node-handles`: wrap raw browser capabilities
  once, preserve a descriptor's `_internal`, platform, canonical I/O path and
  durable root identity, and inherit a parent root only when the child is
  unstamped. Retain durable root stamps carried by raw browser capabilities as
  well. File-tree and token-indexing maps extract a canonical web
  descriptor's raw capability through their existing capability guard. The
  real-web-adapter processor, shared-loader and lazy-expansion regressions plus
  `file-node-handles.test.ts` pin these boundaries.
- **Chunking re-dispatch is bounded per service session (BST-1229).** A
  hash-unchanged managed-cache row with no `chunks_processed_at` stamp may be
  re-dispatched at most three times. The service-owned in-memory tracker keys
  that budget by collection id, durable root/path, file-record id, and content hash; a
  completed stamp, new record, or changed content resets it. Attempts are
  consumed only at importer handoff, after access, worker startup, and import
  QoS succeed; cancelled or failed pre-import scans do not spend the budget.
  Exhaustion counts the row as scanned-but-unchanged, removes only that row from
  later import batches, logs one explicit terminal diagnostic per exhausted
  revision, and puts Workspace Index in its visible `error` state with the file
  paths and recovery instruction. It does not block unrelated embedding
  backfill, and neither asynchronous backfill progress nor a healthy scan of
  another root can clear the terminal state.
  Partial watcher scans preserve errors for paths they did not examine and
  clear only errors covered by that scoped scan; an ignored root-self removal
  preserves the existing errors. Inaccessible content reads preserve the
  matching path errors during both scoped and full scans. Switching or disabling
  the managed collection discards errors owned by the retired collection. Each
  provider loop also reconciles the service against the complete mounted-root
  identity set. The durable adapter root ID is retained through both DB routing
  and terminal-scope reconciliation, including the `rootIdByPath` fallback for a
  legacy mounted handle without a stamped `rootId` (never project down to path
  plus nullable DB ID), so removing one root cannot leave its error attached to healthy sibling
  roots and same-path web roots cannot exchange identities. Full
  scans prune retry state for paths no longer present. If reconciliation leaves
  only mounted roots without resolved database ids, the provider replaces any
  retired root's terminal error with the explicit unresolved-root waiting status;
  a zero-syncable-target loop must not leave stale status visible. Never replace
  this with an unbounded retry. A redispatch attempt is recorded only when its
  concrete import batch enters `processChunking`, the second content read selected
  that file, and its managed-cache apply succeeded; unreadable files, failed
  applies, post-base model/worker setup failures, and cancellation or failure in
  an earlier batch must not spend untouched retry budgets. Never use a
  quiet skip. This is intentionally not persistent sync state: restarting the
  renderer grants a fresh bounded budget.

The policy test owns the preset contract. The parallel-directory-walker test
must also prove excluded directories are rejected before `readDirectory` is
called. Provider/service tests own policy-switch cancellation and stale-progress
suppression.
