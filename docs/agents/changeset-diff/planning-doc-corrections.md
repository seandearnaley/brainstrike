# Corrections to earlier planning docs — evidence

Supports `docs/agents/changeset-diff.md` § "CORRECTIONS TO EARLIER PLANNING DOCS".
Read before trusting a claim from `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md` or PR #2252's body.

The lines below are the pre-distillation contract text, extracted verbatim.

> **Correction, verified 2026-09-21.** Two of the bullets below are themselves
> stale and are NOT true today:
>
> - "`WorktreeProvenance`'s `'agent-reported'`/`'both'` values are never
>   produced" is false. `apps/desktop/src/assistant-server/worktree-adopt.ts`
>   emits `provenance: row ? 'both' : 'scanned'` for every inventory-backed
>   entry and `provenance: 'agent-reported'` for a live ledger row that is
>   missing on disk. `GitInventoryService` itself still produces only
>   `'scanned'`; the merge happens in `worktree-service.ts`'s `list()` through
>   that helper. `packages/app-shell/src/worktree-map/` branches on
>   `'agent-reported'` in production code.
> - "only the `revertible` field (computed by
>   `foldJournalRecords`/`isEntryRevertible`)" names two symbols that no longer
>   exist anywhere in `apps/` or `packages/`; they died with the BST-1164 T4
>   journal fold. `revertible` is now computed as `true` for every
>   snapshot-resolved entry.
>
> The `ConversationRevertService` bullet and the 3-variant-union bullet were
> re-checked against the tree and still hold.

- **`StructuredFileDiffContent` is a 3-variant union** (`binary` | `full` |
  `hunks-only`), where `hunks-only` carries a 4-value `reason`. PR #2252's
  body describes "a 4-reason content union (`hunks`, `binary`, `too-large`,
  `error`)" — that is not what shipped; read `packages/types/src/changeset.ts`
  directly rather than that PR body.
- **No `ConversationRevertService`/soft-rewind exists.** The design spec's
  W5 scope is unimplemented on this branch; only the `revertible` field
  (computed by `foldJournalRecords`/`isEntryRevertible`) ships.
- **`WorktreeProvenance`'s `'agent-reported'`/`'both'` values are never
  produced.** Only `'scanned'` — see SERVICES above.
- ~~**No live push-to-renderer refresh exists**~~ — CLOSED by BST-1161:
  `changes:invalidated` + the renderer generation guard now exist. See
  REFRESH SEAMS above for exactly what refreshes on it.
