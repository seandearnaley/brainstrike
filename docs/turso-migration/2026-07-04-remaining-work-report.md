# Turso Migration — Remaining Work Report

**Date:** 2026-07-04
**Branch:** `feature/turso-migration` (166 commits ahead of `main`, 3 behind)
**Sources:** `docs/turso-migration/migration-ledger.md` (updated 2026-07-04),
`docs/turso-migration/2026-07-02-independent-audit-report.md`, live `gh` PR/CI
state, live fetch of current Turso docs (2026-07-04).

---

## TL;DR

The desktop migration is **functionally complete**. Turso is the default
desktop runtime (unset `BRAINSTRIKE_DB_RUNTIME` → Turso, even over legacy
`pgdata`), and every major subsystem — repositories, job queue, embedding
host, assistant memory/persistence, grep/vector/hybrid search, DB Explorer,
factory reset, scheduled maintenance — has a proven Turso path with
real-engine tests. The three HIGH findings from the 2026-07-02 independent
audit have all been remediated by subsequent slices (#1443, #1453/#1454, and
the ledger's MVCC disclosure section).

What remains falls into five buckets, in dependency order:

1. **One green PR to merge right now** (#1470).
2. **The browser/web runtime** — the only subsystem still PGlite-owned. The
   Turso WASM path is scaffolded but blocked at real-browser store-open/MVCC
   probes. This is the largest remaining engineering chunk.
3. **Three explicit product/release decisions** that are deliberately parked
   as decisions, not code: MVCC-beta signoff, lexical search quality
   (gram vs. split Tantivy FTS), and desktop PGlite compat retirement.
4. **The final PGlite dependency-removal audit** — gated on buckets 2 and 3.
5. **Merge to main** — housekeeping (rebase onto main's 3 new commits, track
   the audit artifact) and the integration PR itself.

---

## 0. Immediate: merge the open PR

- [ ] **T0.1 — Merge PR #1470** `feat(preferences): own browser Turso WASM reset state`
  - Status: **all ~35 checks green, MERGEABLE**, base `feature/turso-migration`.
  - Adds factory-reset ownership for the planned browser `brainstrike-web-turso.db`
    OPFS file family. This is a prerequisite piece of workstream B's
    "reset/backup ownership" gate.
  - Note: `gh` works fine from this machine when run non-interactively with
    `GH_PAGER=cat` and a kill-guard; the hangs are likely pager/prompt related,
    not API-side.

---

## A. Browser / Web runtime (largest remaining engineering work)

**Context.** The browser DB provider is still PGlite-backed *by explicit
ledger decision*, not as a hidden fallback. Current Turso docs (verified
2026-07-04) document browser-local Turso via `@tursodatabase/database-wasm`
(the "Wasm + Vite" connect example) with OPFS + SharedArrayBuffer/COOP-COEP
requirements; the package is still beta. The branch has already landed the
package dependency, a browser-only `@brainstrike/db/turso/browser-wasm-client`
Vite seam (#1468), an explicit web runtime selection
`{ engine: "turso", host: "browser", persistence: "opfs" }` with a browser
bootstrap readiness report (#1469), and architecture guardrails locking which
packages may ever touch the browser bundle (#1464). PR #1470 adds reset
ownership.

**Current blocker (from real Chromium smoke coverage):**

- Fresh Linux Playwright fails while *opening the store* on the package
  `whenLoaded` path.
- Local macOS Chromium opens the store but fails at the
  `PRAGMA journal_mode = 'mvcc'` probe.
- Schema baseline + search-primitive readiness are fail-closed behind those
  probes (correctly, per the no-silent-fallback rule).

**Tasks (roughly in order):**

- [ ] **A1 — Diagnose/resolve the WASM store-open failure on Linux Chromium**
  (`whenLoaded` path). Likely upstream-package or COOP/COEP/worker-wiring
  issue; reproduce in the existing Playwright smoke lane, and file an upstream
  issue against `@tursodatabase/database-wasm` if it's a package defect.
  *Acceptance:* browser bootstrap reaches the MVCC probe on Linux CI.
- [ ] **A2 — Resolve the MVCC pragma failure in browser WASM, or make an
  explicit journal-mode decision for the browser store.** The desktop path
  hard-requires `journal_mode = 'mvcc'`; the browser WASM build may not
  support it (MVCC is still experimental upstream). Decide: (a) wait for/land
  upstream MVCC-in-WASM support, or (b) declare a documented, tested
  browser-specific journal-mode contract (single-writer browser tab may not
  need MVCC) and relax the probe *for the browser report only*.
  *Acceptance:* browser bootstrap report reaches `ready` with an explicit,
  documented journal-mode decision; no silent divergence from desktop.
- [ ] **A3 — Schema baseline + search primitives in browser WASM.** Run the
  greenfield baseline ledger (v6) and the vector32/gram probes through the
  browser seam once A1/A2 unblock. *Acceptance:* browser report includes
  `search.grep-content-grams` and `search.vector32-functions` outcomes.
- [ ] **A4 — Provider integration.** Wire `DbProvider` to construct Turso
  repositories from the browser WASM client behind the browser readiness
  report (mirroring the desktop bootstrap gating). Embedding-worker storage
  port for the browser (the port from #1373 exists; the browser Turso adapter
  does not).
- [ ] **A5 — Offline semantics + persistence proof.** OPFS durability across
  reload, storage-pressure/eviction behavior, and multi-tab ownership (OPFS
  access handles are exclusive — define single-owner semantics analogous to
  the desktop owner client). *Acceptance:* explicit tests, not assumptions.
- [ ] **A6 — Runtime parity test lane.** The ledger requires "runtime parity
  tests" before the browser PGlite worker can be replaced: same repository
  contract suites run against browser-WASM Turso that already run against
  desktop Turso and PGlite.
- [ ] **A7 — Browser cutover decision + PGlite worker retirement.** Only after
  A1–A6: flip the web default, keep the guardrail tests
  (`architecture-browser-runtime-ownership.test.ts`) updated in the same PR.
- [ ] **A8 — (Done on web-server side, verify only)** Web Vite Node server
  Mastra storage already moved to embedded Turso (#1463); confirm no other
  server-side web path constructs PGlite directly (the import guardrail
  #1462 enforces this).

**Grounding note (current Turso docs):** `@tursodatabase/database-wasm` is the
only approved browser-local package. `@libsql/client/web` cannot open local
files; `@tursodatabase/serverless` is a remote fetch client (would make
latency-critical writes remote — forbidden by project constraints);
`@tursodatabase/sync` is the local-first sync package (TS/Python/Go, explicit
`push()`/`pull()`, "last push wins" conflicts) — relevant only if the product
later wants cloud sync, and would then need explicit reset targets (§7 of the
ledger) and a conflict-model product decision.

---

## B. Release-readiness signoffs (vendor risk — decisions, not code)

- [ ] **B1 — MVCC / `BEGIN CONCURRENT` maturity signoff.** *Verified today:*
  Turso's own quickstart still lists `--experimental-mvcc` under experimental
  features with "These features are not production ready, so do not use them
  for critical data right now," while the TS SDK reference simultaneously
  recommends `@tursodatabase/database` ("concurrent writes (MVCC) and async
  I/O") as the local embedded package. Brainstrike hard-requires
  `journal_mode = 'mvcc'` and uses `BEGIN CONCURRENT` in every owner
  transaction — the whole desktop runtime rides on a feature the vendor still
  labels experimental in at least one authoritative page. The ledger now
  discloses this (audit HIGH #1 remediated), but the *signoff* is still open.
  *Acceptance:* a dated ledger entry recording the team's explicit accept /
  mitigate decision, backed by the existing corruption-recovery path (#1406),
  reset validation, and the real-engine test suite. Since there are no users
  yet, "accept with monitoring + backup validation" is a defensible call —
  but write it down.
- [ ] **B2 — Queue topology acceptance thresholds in a release checklist.**
  The two-process serialized-owner design (audit HIGH #3) now has profiling
  proof: sustained E2E lane (#1454) requires `tursoQueueProfile: accepted`
  with foreground waits under threshold. Remaining: fold the reopen triggers
  (`slowQueuedOperationCount > 0` for foreground labels, or repeated >1000ms
  foreground waits behind background work) into the release checklist so the
  "reopen separate-connection design" clause has a concrete owner.
- [ ] **B3 — Mastra vector exact-scan budget check.** Baseline is
  characterized (5,000×384 dims: recall@K 1.000, p95 30.4ms). Decide the
  acceptable memory-volume envelope; native vector-index/ANN work is
  explicitly deferred unless real profiles exceed it. *Acceptance:* one-line
  budget in the ledger (e.g. "exact scan accepted up to N rows").

---

## C. Product decisions deliberately parked

- [ ] **C1 — Lexical search quality: primary-store grams vs. split Tantivy FTS
  store.** Current path is gram-sidecar candidates + exact substring guard
  (precision@5 0.400 / recall@5 1.000 on the seeded corpus, per the
  2026-07-03 profile). Current Turso docs document native Tantivy FTS
  (`CREATE INDEX ... USING fts`, `fts_match`/`fts_score`/`fts_highlight`,
  ngram tokenizers) **but** the branch's capability spike proved FTS custom
  indexes fail inside an MVCC database — so native FTS would require a
  *separate non-MVCC search-index store* with its own bootstrap/reset/rebuild
  ownership. Trigger conditions are already written in the ledger (BM25 as a
  first-class signal, field weighting, engine-owned highlighting, or gram
  write-amplification in profiling). *Acceptance:* a product call: "gram path
  ships v1" or a scoped split-store plan. Recommendation: ship gram for v1
  (no users; recall is 1.0; split store is a large ownership surface), and
  re-probe FTS-under-MVCC each Turso release.
- [ ] **C2 — Desktop PGlite compatibility retirement.**
  `BRAINSTRIKE_DB_RUNTIME=pglite` is the only remaining desktop PGlite opt-in.
  Decide when to delete it (it currently serves compatibility checks and the
  explicit-PGlite test lanes). Retiring it unlocks most of workstream D.
- [ ] **C3 — Live-query capability stance for Turso.** Capability is
  explicitly `false`; all 12 known consumers are runtime-split
  (PGlite live query / Turso snapshot+invalidation) or fail-closed, and
  guardrail test #1461 locks the inventory. Decide whether event-driven
  snapshots are the *permanent* Turso answer (recommended — it's working) or
  whether a future Turso CDC/reactive feature should be tracked. No code
  needed now.

---

## D. Final PGlite dependency-removal audit (gated on A + C2)

- [ ] **D1 — Shrink the direct-import allowlist to zero (or browser-only).**
  `architecture-pglite-import-guardrails.test.ts` currently allowlists
  **~18 files** importing `@electric-sql/pglite*` (each with owner + reason).
  Every browser cutover / compat-retirement slice should delete its entries.
- [ ] **D2 — Remove PGlite packages, Vite aliases, type shims, WASM packaging.**
  Touchpoints: `apps/desktop/package.json`, `apps/desktop/vite.config.mts`,
  `apps/web/package.json`, `apps/web/vite.config.mts`,
  `packages/db/src/wasm-loader.ts`, `packages/build-utils`,
  `apps/desktop/src/types/pglite*.d.ts`. **Do not do this early** — the ledger
  is explicit that premature cleanup breaks the still-supported explicit
  PGlite mode and browser path without advancing parity.
- [ ] **D3 — Retire the PGlite migration chain + numbered runner** (or archive
  them) once no supported runtime executes them. Includes the
  PGlite-only dimension-index (HNSW) maintenance path.
- [ ] **D4 — Final stale-wording sweep** (AGENTS.md PGLITE EXTENSION
  INVARIANT section, factory-reset PGlite IndexedDB cleanup notes, etc.) —
  ledger marks this final-pass-only; #1459/#1460 already cleared the known
  backlog.

---

## E. Branch hygiene and landing on main

- [ ] **E1 — Track the independent audit artifact.** The 2026-07-02 audit
  report exists on disk but is **untracked**; the ledger explicitly refuses to
  cite it until committed. Commit `docs/turso-migration/
  2026-07-02-independent-audit-report.md` (plus the other 6 untracked docs
  files shown in `git status`) so the remediation trail (#1443, #1453/#1454)
  is auditable.
- [ ] **E2 — Reconcile with main.** Branch is 3 commits behind `main`; merge
  or rebase main in before the next stack of slices to keep the eventual
  integration PR reviewable.
- [ ] **E3 — Integration PR to main.** After A (or an explicit decision to
  land desktop-Turso with browser-PGlite still in place — viable, since the
  browser boundary is guardrail-enforced), open the feature→main PR. Given
  166 commits, plan for: a fresh full-suite run (`pnpm lint && pnpm
  type-check && pnpm build && pnpm test`), the nightly E2E lanes, and an
  updated AGENTS.md TURSO RUNTIME INVARIANT section if anything shifted.

---

## What is *not* remaining (recently closed, don't re-litigate)

- Desktop default runtime = Turso, including legacy-`pgdata` profiles (#1458, #1466).
- Audit HIGH #2 (model-registry ungated write path) — fixed by runtime-specific
  SQL helper + provider gating (#1443, #1460).
- Audit HIGH #3 (untested 2-process queue) — deterministic + sustained E2E
  profiling proof with accept/block verdicts (#1451–#1454).
- Factory reset / `db:clearAll` real-engine proofs, corruption recovery,
  re-embed composition, embedding-set membership semantics, assistant
  tool-approval suspend/resume on Turso workflow storage — all merged with
  real-engine tests.
- Web-server Mastra storage on embedded Turso (#1463).

## Doc citations (fetched live 2026-07-04)

- MVCC status: <https://docs.turso.tech/tursodb/quickstart> — "not production
  ready … do not use for critical data right now" (experimental flags).
- Package guidance: <https://docs.turso.tech/sdk/ts/reference> —
  `@tursodatabase/database` (local embedded), `@tursodatabase/serverless`
  (remote), `@tursodatabase/sync` (local-first sync), `@libsql/client` (ORMs).
- Browser: <https://docs.turso.tech/connect/javascript> — "Wasm + Vite —
  Browser (WASM), local database in the browser".
- Sync semantics: <https://docs.turso.tech/sync/usage> — explicit
  `push()`/`pull()`, "last push wins", offline-first via `bootstrapIfEmpty: false`.
