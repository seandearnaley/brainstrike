# Sync-the-mind op-log seam — evidence

Supports `docs/agents/assistant-persistence.md` §
"SYNC-THE-MIND OP-LOG SEAM". Read this before proposing to change the op-log vocabulary, the one cascade spec, or delegated-branch deletion.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Per the 2026-07-28 BST-911 ruling, future sync covers the "mind" —
threads/memory/prompts — never vectors/HNSW. The groundwork laid here is a
tombstone seam, deliberately nothing more (no engine choice, no write-path op
emission — that is engine territory):

- **Where state lives:** `brainstrike_mind_ops` (migration 079 in BOTH
  runners; migration-owned since BST-1651 retired the repository's bootstrap
  mirror). Append-only:
  `seq BIGSERIAL` is the lamport-ish local order; `entity_kind` ∈
  {`thread`, `prompt_item`} and `op` = `delete` are CHECK-constrained on
  purpose — widening the vocabulary is a conscious migration, never a drift
  channel. Thread tombstones capture `resource_id` from the delete's own
  RETURNING — the workspace scope is unrecoverable once the thread row is
  gone, and a per-resource sync engine could never partition the log after
  the fact (nullable: prompt items are global). Sidecar-not-ALTER: Mastra
  owns the `mastra_*` schema and its lazy tables have no evolution
  mechanism.
- **Tombstones derive FROM the log.** No `deleted_at` columns anywhere: rows
  still physically disappear, so the thread-search orphan GC's anti-join and
  the readonly sandbox role's visibility rules are untouched.
- **One cascade spec.** `THREAD_DELETE_SIDECAR_TABLES` (assistant contract,
  `mastra-memory-schema`) is the ordered thread-delete cascade over the
  Brainstrike sidecars. All THREE delete implementations derive from it: the
  single-thread CTE, the bulk CTE (previously drifted in both stage-set and
  order), and the Mastra `MemoryStorage.deleteThread` override (previously
  deleted only the three Mastra tables). The single-thread CTE now owns the
  placements stage itself instead of relying on the panel's separate
  `clearThreadPlacement` round trip.
- **Ops record actual deletions.** Each path inserts one `thread` op per
  thread row it actually deleted (idempotent deletes emit nothing; a rejected
  bulk delete emits nothing). `PromptItemRepository.delete` emits
  `prompt_item` ops the same way. The standalone Mastra store probes the
  app-owned sidecars with `to_regclass` (a bare store legitimately lacks
  them and has no seam to feed); on a migrated database every probe passes.
- **Delegated branches:** all three paths use `DELEGATED_THREAD_DELETE_CTES`
  to include descendant native threads and their sidecars. It validates the
  complete live ancestry and descendants before selecting any deletion target;
  a changed owner/resource rejects the whole command. Parent/sibling threads
  outside a selected subtree survive. Artifact bytes match either root read
  ownership or native execution identity; both thread-search index/state tables
  and saved workspaces are deleted in the same cascade. Run/event rows cascade
  through native foreign keys. Numeric usage remains historical spend, not
  saved transcript data. Queued workspace saves require the still-existing
  exact native owner. Rejected outgoing saves evict the snapshot cache; a
  still-active save failure reaches navigation with its exact resource/thread
  identity. It invalidates only that owner's readiness and reports a matching
  pending navigation error. A late rejection from an unmounted coordinator
  cannot invalidate a different owner's ready workspace or pending navigation.
  Other write failures remain errors. Overlapping bulk
  requests emit each tombstone once. The desktop
  `delegated-thread-deletion.integration.test.ts` exercises all three real-PGlite
  paths, including rejected deletions.
- **Reset:** registered in the reset registry — the op-log is cleared with
  the mind it describes on all three clear paths.

Paired tests: `migration-079-mind-ops-log.test.ts`, the tombstone cases in
`assistant-memory-repository.integration.test.ts`,
`pglite-memory-store.integration.spec.ts`, and
`prompt-item-repository.test.ts`.

