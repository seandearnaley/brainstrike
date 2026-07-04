# Turso Migration — Release-Readiness Decision Records (PROPOSED)

**Date:** 2026-07-04
**Status:** PROPOSED — each record below requires explicit signoff from Sean
before it is treated as accepted. Signoff is recorded by changing a record's
status line and adding the date.
**Context:** remaining-work items B1–B3 and C1–C3 from
`2026-07-04-remaining-work-report.md`; audit follow-ups from
`2026-07-02-independent-audit-report.md`.

---

## DR-1 (B1): MVCC / `BEGIN CONCURRENT` vendor-maturity acceptance

**Status:** PROPOSED
**Decision:** Accept the MVCC-beta risk for the current no-users phase, with
the mitigations below, and re-verify vendor status at every
`@tursodatabase/database` version bump.

**Facts (verified against live docs 2026-07-04):**

- The TursoDB quickstart still lists `--experimental-mvcc` among experimental
  features: "These features are not production ready, so do not use them for
  critical data right now."
- The TypeScript SDK reference simultaneously recommends
  `@tursodatabase/database` as the local embedded package, described as
  "Built on the Turso Database engine with concurrent writes (MVCC) and async
  I/O."
- Brainstrike hard-requires `PRAGMA journal_mode = 'mvcc'` at owner-client
  construction and uses `BEGIN CONCURRENT` for every non-exclusive owner
  transaction, including Mastra workflow storage (tool-approval
  suspend/resume state).

**Mitigations already in place:**

- Corruption-recovery boundary (#1406): explicit SQLITE_CORRUPT/NOTADB
  signals during bootstrap trigger backup + profile reset + one retry.
- Real-engine test coverage on every Turso write path (ledger verification
  policy), including 5-client queue race proofs and sustained queue-profile
  E2E.
- Factory reset / `db:clearAll` real-engine proofs.
- Greenfield posture: no production users, no data-continuity promise yet.

**Residual risk accepted:** silent logical corruption inside MVCC that does
not surface a recognizable corruption signal. No mitigation exists beyond
vendor maturation; this is the core reason the record must be re-reviewed
before any release that carries user data.

**Review trigger:** any `@tursodatabase/*` upgrade, any upstream
announcement moving MVCC to stable, or the first release candidate with real
users — whichever comes first.

**Signoff:** ___ (pending)

---

## DR-2 (B2): Two-process queue topology — acceptance thresholds

**Status:** PROPOSED
**Decision:** Keep the single-owner-client serialized topology. Adopt the
following as *release-checklist items* (not aspirations):

1. `desktopDiagnostics.getSnapshot().tursoQueueProfile` must be `accepted`
   on a release-candidate build under the sustained E2E profile lane
   (#1454).
2. Reopen the separate-connection design if either trigger fires during RC
   profiling or nightly E2E:
   - `slowQueuedOperationCount > 0` for foreground-labeled work, or
   - foreground DB work repeatedly (>1 occurrence per session) waiting
     >1000ms behind background/embedding owner operations.
3. Owner of the check: whoever cuts the release runs the sustained lane and
   records the verdict in the ledger.

**Rationale:** audit HIGH #3 asked for either an integration test or an
explicit monitored acceptance; #1453/#1454 delivered the test, this record
makes the acceptance and its triggers explicit.

**Signoff:** ___ (pending)

---

## DR-3 (B3): Mastra vector memory exact-scan budget

**Status:** PROPOSED
**Decision:** Exact-scan vector retrieval is accepted for Mastra memory up to
**25,000 vectors per profile** at 384–1024 dimensions. Measured baseline
(2026-07-03): 5,000×384 rows, recall@K 1.000, p95 30.4ms. Linear
extrapolation puts 25k rows at roughly 150ms p95, inside the assistant
memory-recall latency envelope (recall happens once per turn, off the
keystroke path).

**Action on breach:** re-run
`pnpm --filter @brainstrike/agent run bench:turso-vector-memory` at the
observed volume; if p95 exceeds 250ms, open the native vector-index/ANN
decision (schema change owned by the Mastra memory store, not the bootstrap
baseline).

**Signoff:** ___ (pending)

---

## DR-4 (C1): Lexical search — primary-store grams for v1, FTS deferred

**Status:** PROPOSED
**Decision:** The primary-store gram path ships v1. The split native
Tantivy FTS search-index store is NOT pursued now.

**Rationale:**

- Measured quality (2026-07-03 profile): recall@5 1.000, precision@5 0.400
  on the seeded corpus — recall is the binding constraint for code search;
  precision is acceptable for v1 with the exact-substring guard.
- The capability spike proved FTS custom indexes fail inside an MVCC
  database, so native FTS requires a second non-MVCC store with its own
  bootstrap/reset/rebuild/freshness ownership — a large surface with no
  users demanding it.
- The ledger already enumerates the reopen triggers (BM25 as a first-class
  quality signal, field weighting, engine-owned highlighting, gram
  write-amplification/storage growth in profiling).

**Standing task:** re-probe FTS-under-MVCC (the spike) at each Turso minor
release; the decision flips only via a new dated record.

**Signoff:** ___ (pending)

---

## DR-5 (C2): Desktop PGlite compatibility retirement plan

**Status:** PROPOSED
**Decision:** Retire `BRAINSTRIKE_DB_RUNTIME=pglite` (and its test lanes) only
after BOTH:

1. the browser runtime cutover (workstream A) lands — so PGlite has no
   remaining production owner anywhere, and
2. one full nightly cycle (web + desktop E2E regression) passes green with
   Turso as the only exercised runtime.

Until then the explicit opt-in stays, because the PGlite lanes still serve as
the comparison oracle for dialect-split code paths.

**Consequence:** workstream D (dependency/Vite-alias/type-shim/WASM-packaging
removal, migration-chain retirement) is gated on this record flipping to
ACCEPTED, per the ledger's warning that premature cleanup breaks supported
paths.

**Signoff:** ___ (pending)

---

## DR-6 (C3): Live-query stance under Turso

**Status:** PROPOSED
**Decision:** Event-driven repository snapshots (explicit invalidation
triggers, no polling) are the *permanent* Turso answer for reactive UI, not a
stopgap. The live-query capability stays `false` for Turso; guardrail test
#1461 remains the enforcement point. Upstream Turso CDC/reactivity features
may reopen this with a new record, but nothing is tracked or awaited.

**Signoff:** ___ (pending)
