# Turso Migration — Remaining Issues & Developer Handoff

**Date:** 2026-07-05
**Branch:** `feature/turso-migration`
**Audience:** the next developer picking this up cold. This document is
self-contained: read it top to bottom and you will know what is done, what is
blocked, why, and exactly what to do next.

---

## 1. TL;DR

The PGlite → Turso migration is **substantially complete and green** on
`feature/turso-migration`:

- **Desktop is fully migrated** and is the primary product. It runs the **native**
  `@tursodatabase/database` engine, is the default runtime (unset
  `BRAINSTRIKE_DB_RUNTIME` → Turso), and every desktop subsystem
  (repositories, job queue, embedding host, assistant memory/persistence,
  grep/vector/hybrid search, DB Explorer, factory reset, scheduled maintenance)
  has real-engine test coverage. **Desktop is unaffected by every issue below.**
- **The web/browser runtime is wired and proven** — a real `ready` bootstrap in
  Chromium, provider-constructed Turso repositories over OPFS, embedding-worker
  storage, a **zero-gap runtime-parity lane** (13 repository contracts identical
  across native Turso and browser WASM), reset ownership, and OPFS durability.

**There is exactly one hard blocker preventing "full" completion**, and it is a
**vendor bug in `@tursodatabase/database-wasm`, not in our code**: a
data-dependent lockup in the WASM engine's indexed-insert path that hangs browser
chunk-indexing on realistic file contents. Because of it:

1. The web runtime ships with **browser chunk indexing fail-closed** (loud, typed
   refusal; PGlite remains the web-indexing escape hatch via
   `VITE_BRAINSTRIKE_DB_RUNTIME=pglite`).
2. **Full PGlite removal from the web bundle is deferred** until a fixed vendor
   release lands — PGlite must remain the web escape hatch.

Everything achievable today is done or in a PR. The rest is gated on the vendor.

---

## 2. How to run / smoke test right now

```bash
# Desktop (native Turso engine — the fully migrated, unaffected path):
pnpm --filter @brainstrike/desktop dev          # dev server + Electron; boots on Turso by default
pnpm --filter @brainstrike/desktop start        # or the built app

# Force the legacy engine for an A/B comparison (only remaining PGlite opt-in):
BRAINSTRIKE_DB_RUNTIME=pglite pnpm --filter @brainstrike/desktop dev

# Web:
pnpm --filter @brainstrike/web dev              # defaults to browser Turso once the cutover PR lands (see §5)
VITE_BRAINSTRIKE_DB_RUNTIME=pglite pnpm --filter @brainstrike/web dev   # web escape hatch (full indexing)
```

Desktop smoke checklist: boot (confirm Turso runtime in DB Explorer/diagnostics),
import a real folder (chunking + embedding backfill — the native engine handles
the exact workload that hangs in the browser), assistant chat (memory, tool
approval, reload hydration), search (grep / semantic / hybrid / quick-open),
vector status, factory reset (must recreate a fresh Turso profile, never an empty
`pgdata`).

---

## 3. THE blocker — WASM indexed-insert lockup (vendor)

**Reproduce it yourself in ~1 minute:**
[`repro/wasm-indexed-insert-lockup/`](repro/wasm-indexed-insert-lockup/) —
`node sweep.mjs one 2500` passes (commits in ~25 ms); `node sweep.mjs one 3000`
hangs (transaction never settles). Full README in that directory.

**What it is:** inside a transaction, an `INSERT` into a table with a PRIMARY KEY
or a secondary index hangs **mid-statement with no error** for specific
data-dependent payloads. The statement promise never settles and the connection
wedges — but `db.close()` still resolves, so the engine is not CPU-spinning; the
statement's async completion is *lost*.

**Key facts (all verified this session, reproduced deterministically 3+× each):**

- **Not a volume threshold.** 2900/3000/3100/3200-byte payloads hang; 2850/3400/
  32 K/1 MB pass. The 32 K gram key set is a strict superset of 3000's, yet passes.
  The trigger is a page-state/key-distribution coincidence in the index btree.
- **Localized to the indexed-insert path.** Grams table with no PK and no index →
  passes; PK-only → hangs; secondary-index-only → hangs.
- **The native engine is fine.** `@tursodatabase/database` (desktop) commits the
  identical statement stream in 4–7 ms (WAL and MVCC). Desktop is not exposed.
- **No vendor bump fixes it.** `0.7.0-pre.17` (newest published) is bit-identical
  in behavior to the installed `0.6.1`.
- **No config workaround.** `PRAGMA wal_autocheckpoint` is not a valid pragma in
  the wasm build; `wal_checkpoint(TRUNCATE)` runs but does not help.
- **Restructuring is unsound.** Composition changes *which* payloads trip it, so
  splitting writes only reshuffles the landmine field — it cannot bound the risk.

**This is the third empirically-proven `@tursodatabase/database-wasm` defect this
migration surfaced** (after an MVCC-open panic and an `@emnapi` worker-init skew,
both documented in
[`2026-07-04-wasm-store-open-and-mvcc-diagnosis.md`](2026-07-04-wasm-store-open-and-mvcc-diagnosis.md)).
The browser package is genuinely early — consistent with its beta status.

**The only real fix is upstream.** A ready-to-file issue with the repro is at
[`upstream-issue-wasm-indexed-insert-lockup.md`](upstream-issue-wasm-indexed-insert-lockup.md)
(not filed — owner's call).

---

## 4. What is DONE (merged into `feature/turso-migration`)

Desktop migration landed earlier in the branch's history (#1304–#1466 range: runtime
selection, owner client, repositories, queue, memory, search, reset, maintenance).
The browser workstream and supporting work landed this session:

| PR | What |
| --- | --- |
| #1470 | browser Turso WASM reset ownership (OPFS file family) |
| #1471 | track migration audit/research docs (incl. the independent audit report) |
| #1472 | **release-readiness decision records DR-1…DR-6** (see §7) |
| #1473 | browser store-open reliability (vitest browser-project `optimizeDeps` + bounded retry) |
| #1474 | sync browser-ownership guardrail with reworded ledger |
| #1475 | CI planner: guardrail-scanned docs now trigger their DB test lanes |
| #1476 | **browser WAL journal-mode contract** (fail-closed; MVCC is native-only) |
| #1477 | **wire browser Turso through `DbProvider`** (repositories over OPFS) |
| #1478 | **browser Turso embedding-worker storage** (+ FIFO client serialization) |
| #1481 | **runtime-parity lane** — 13 contracts identical native ⇄ browser, zero gaps |
| #1482 | **browser reset ownership + OPFS durability proof** (+ FK-pragma discipline) |

Notable engine facts proven along the way: browser MVCC is broken upstream, so the
browser uses **WAL + single-writer plain `BEGIN`** by documented contract (desktop
keeps MVCC); the browser WASM database serializes **statements, not transactions**,
so `createTursoBrowserWasmExecutionClient` wraps it in a **FIFO queue**;
`PRAGMA foreign_keys` is **connection-scoped** (the long-lived store must
re-enable + verify it, or cascade deletes silently orphan sidecars).

---

## 5. What is IN FLIGHT — the A7 cutover PR

**Branch:** `feat/turso-browser-default-cutover` (pushed; **not yet merged**).

This flips the **web default** to browser Turso (with `VITE_BRAINSTRIKE_DB_RUNTIME=pglite`
as the strict-parsed opt-out), requests `navigator.storage.persist()` at
browser-Turso boot, and — because of §3 — gates browser chunk indexing
**fail-closed**:

- `packages/db/src/turso/browser-chunk-indexing-gate.ts` — a typed
  `BrowserTursoChunkIndexingBlockedError` and a `BROWSER_TURSO_CHUNK_INDEXING_ENABLED`
  constant (currently `false`). Manual import chunking and background indexing
  refuse loudly under browser Turso, naming the vendor defect and pointing at the
  PGlite opt-out. **Non-chunking browser surfaces stay fully enabled** (boot,
  repositories, reset, durability, search over existing rows, file records).

At handoff the cutover was being finished and verified after two subagents were
interrupted by account spend limits; the WIP was preserved as a clearly-marked
commit and is being driven to green (full type-check, db/db-explorer/app-shell
suites, browser project, web build, and the fail-closed + PGlite-opt-out E2E
contracts) before its PR opens against `feature/turso-migration`. **Check the open
PRs on `feature/turso-migration` for its current state.**

### Re-enabling browser chunk indexing when the vendor fixes the bug

This is the single most important forward-looking instruction. When a fixed
`@tursodatabase/database-wasm` release ships (verify with the repro in §3):

1. Bump `@tursodatabase/database-wasm` in `packages/db/package.json`; re-run the
   repro across the known-hang sizes and confirm all commit.
2. Flip `BROWSER_TURSO_CHUNK_INDEXING_ENABLED` to `true` in
   `packages/db/src/turso/browser-chunk-indexing-gate.ts`.
3. Flip the paired E2E gate (`WEB_TURSO_CHUNK_INDEXING_BLOCKED` in
   `apps/web/e2e/utils/turso-gates.ts`) so the full import/backfill web E2E specs
   run again on the Turso default — they are the real-engine regression proof.
4. Update the migration-ledger finding with the fixed version.
5. Then §6 (full PGlite removal) becomes unblocked.

---

## 6. What REMAINS (backlog, in dependency order)

1. **Land the A7 cutover PR** (§5) — review, green CI, merge into the feature branch.
2. **DR-5 gate #2:** run one full nightly E2E regression on the feature branch
   (`gh workflow run web-e2e.yml --ref feature/turso-migration` and the desktop
   equivalent) and confirm green on the new default.
3. **Workstream D — PGlite removal (PARTIALLY BLOCKED):**
   - *Blocked until the vendor fix:* removing PGlite from the **web bundle** — it
     is the web-indexing escape hatch while §3 stands. Do not remove it.
   - *Not blocked (can proceed):* desktop-side explicit-PGlite compatibility
     retirement decision (DR-5), dead-path cleanup, and shrinking the direct
     PGlite import allowlist (`packages/db/__tests__/architecture-pglite-import-guardrails.test.ts`)
     for any file that no longer needs it. The numbered PGlite migration runner and
     pgvector HNSW maintenance are desktop/Postgres-only and can be scoped for
     retirement once explicit desktop PGlite is dropped.
4. **Vendor watch:** re-run the §3 repro against each new `@tursodatabase/database-wasm`
   release; when it passes, execute §5's re-enable checklist. (Optionally file the
   upstream issue to accelerate a fix.)
5. **Integration to `main`:** the owner performs the `feature/turso-migration` → `main`
   merge themselves. A verification dossier should accompany it (what was proven,
   what changed, residual risks per the decision records).

---

## 7. Decision records (already accepted)

`2026-07-04-release-decisions.md` holds six signed-off records that govern the
above:

- **DR-1** MVCC/`BEGIN CONCURRENT` beta-vendor-risk **accepted** (desktop; re-review at any `@tursodatabase/*` bump or first real-user release).
- **DR-2** two-process queue-topology acceptance thresholds (release checklist).
- **DR-3** Mastra vector exact-scan budget (≤ 25 K vectors/profile).
- **DR-4** lexical search: **primary-store grams for v1**, native Tantivy FTS deferred.
- **DR-5** desktop PGlite retirement gated on the browser cutover + a green nightly.
- **DR-6** event-driven snapshots are the **permanent** Turso answer for reactive UI (live-query stays `false`).

The §3 vendor blocker adds a standing caveat to DR-5: web PGlite removal is
additionally gated on the vendor fix, independent of the desktop retirement.

---

## 8. Map of key files

- **Runtime selection / provider:** `packages/db/src/db-provider.tsx`,
  `packages/db/src/architecture/db-runtime-baseline.ts`, `apps/web/src/db-runtime.ts` (web boot selection, on the cutover branch)
- **Browser WASM seam + bootstrap:** `packages/db/src/turso/browser-wasm-client.ts`,
  `packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts` (WAL contract, FIFO client, FK discipline)
- **Fail-closed gate (cutover branch):** `packages/db/src/turso/browser-chunk-indexing-gate.ts`,
  `apps/web/e2e/utils/turso-gates.ts`
- **Embedding-worker storage:** `packages/vector-management/src/vector-status/turso-browser-embedding-worker-storage.ts`
- **WASM runtime graph pinning (build):** `packages/db/config/turso-wasm-runtime-aliases.mjs`
  (shared by `apps/web/vite.config.mts` and `packages/db/vitest.config.mts`; `@tybys/wasm-util` is a direct dep of `packages/db` for portable resolution)
- **Parity lane:** `packages/db/__tests__/helpers/turso-runtime-parity-contracts.ts`
  (shared bodies), `turso-runtime-parity.test.ts` (native), `turso-browser-runtime-parity.browser.test.ts` (WASM)
- **Architecture guardrails:** `packages/db/__tests__/architecture-browser-runtime-ownership.test.ts`
  (single-construction-site + ledger phrase locks), `architecture-pglite-import-guardrails.test.ts` (import allowlist)
- **The live backlog:** `docs/turso-migration/migration-ledger.md` (re-read before editing; it changes most PRs)

## 9. Gotchas the next dev will hit

- **pnpm 11 state-file masking.** `pnpm install` (even `--force`) can no-op
  ("Already up to date") over a corrupted/partially-restored `node_modules`. Heal:
  `rm -f node_modules/.pnpm-workspace-state-v1.json node_modules/.modules.yaml && pnpm install`.
  This bit local dev and Vercel builds; `apps/web/vercel.json`'s install command
  already clears both.
- **CI planner + docs.** DB architecture guardrail tests string-match doc files
  (ledger, AGENTS.md); a docs-only change that reworded a pinned phrase once landed
  a red lane invisibly. `scripts/affected-unit-tests.mjs` now maps guardrail-scanned
  docs to the DB lanes — keep that mapping current if you add a scanned doc.
- **Cross-package type contracts.** Adding a required field to a shared type (e.g.
  `ProfileBootstrapReport`) breaks distant consumers; run **root** `pnpm type-check`,
  not just the touched package's.
- **New `packages/db/__tests__` files** must be registered in
  `packages/db/scripts/db-test-lane-manifest.mjs` (feeds both `test-lanes` and
  `coverage-lanes`); `.browser.test.ts` files are exempt.
- **Browser vitest wedge** needs vitest ≥ 4.1.9 (an orchestrator hang fixed
  upstream; `packages/db` is pinned to 4.1.9 for this reason).
