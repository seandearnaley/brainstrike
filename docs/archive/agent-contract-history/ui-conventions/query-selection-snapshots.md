# Query-selection snapshots and projection tier — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing snapshot read dedupe, the 100ms loading promotion, the 30s read timeout, or the bounded structural tier in `selection-projection.ts`.

Extracted verbatim from the pre-distillation contract.

---

- Query-selection snapshot resolution shares one in-flight read per database
  handle and snapshot id. From initial resolver start — including while the
  database provider is initializing — a read promotes the store manifest to
  `loading` only after 100ms; a quicker ready/error result cancels that timer,
  while longer reads still surface honest loading state. Snapshot reads fail
  after 30 seconds so a wedged database handle cannot pin the dedupe entry.
  Descriptor changes and unmounts cancel timers and result publication only —
  `DbHandle.query` has no abort contract, so the underlying database query may
  continue after logical cancellation or timeout. Every loading, ready, and
  error publication revalidates the canonical manifest fingerprint plus
  snapshot id; unresolved selections use the persisted materialized-path
  fallback, while ready manifests retain only the materialized base and apply
  included/excluded descriptor overrides during resolution. Consumers that
  need effective counts or paths—including forest budgeting and folder-state
  snapshots—must resolve the descriptor plus manifest rather than reading raw
  `manifest.filePaths`. A terminal read error remains visible until the
  descriptor or database lifecycle changes; the resolver does not silently
  retry or coerce the failed snapshot. The read timeout starts only after a
  database handle exists; if database initialization itself never completes,
  the loading state remains visible rather than being misreported as a snapshot
  read timeout.

---

- Query-selection checkbox projection keeps stable descriptor/materialized-set
  identities on WeakMap fast paths. Hydration can recreate an equal
  `materializedPaths` Set, so `selection-projection.ts` also keeps a bounded
  structural tier for its derived ancestor-count map: four LRU entries and an
  8,000,000-unit retained-weight ceiling. Its coarse order-independent key is
  only a lookup bucket; exact Set membership is verified before reuse, so a
  key collision can cost a rebuild but can never return another selection's
  counts. The tier snapshots paths only for verification and never becomes a
  canonical selection source. Signature construction carries total path length
  into weight accounting so the hot path never rescans selection paths merely
  to estimate retention. A deterministic minimum-weight precheck rejects
  structurally uncacheable oversized selections before lookup, exact-set
  verification, full weight estimation, or snapshot creation. Unresolved
  resolver consumers acquire shared ownership of this MODULE-GLOBAL tier;
  structural admission requires a live owner, while unowned callers retain only
  WeakMap identity entries. Ownership is keyed to unresolved query mode rather
  than descriptor or folder identity, so hydration churn does not clear valid
  entries. Only the final live consumer release clears strong entries. Do not
  make the tier unbounded, clear another live consumer's entries, or use it to
  replace `selectionModel.materializedPaths`.

