# Phase 5→6 Handoff (Completed) and Phase 7 Preview

Status: This handoff brings a self‑contained summary of the DB + Embeddings UI integration work we just completed (Phase 6 core UX), the small correctness fix in the worker, and the practical next steps. It is written for a developer or LLM‑based contractor who may not have full repo context.

---

## Executive Summary

What landed in this pass (user‑visible):
- Vector Status panel (Right Panel → DB tab)
  - Shows pgvector availability (desktop) and worker status (desktop/web)
  - Embedding Set (search/backfill) selector with model key, dimensions, distance
  - Coverage for selected set (counts embeddings present for the set)
  - Throughput (last 60s) and last error
  - Backfill Active Set: enqueues missing embedding jobs with duplicate‑safe keys, batching, and progress indicator
  - Auto‑refresh: when the queue drains, chunk views refresh automatically
- Chunks view improvements
  - Per‑chunk badges reflect embedding relative to the selected set
    - embedded (selected set) | embedded (other set) | no embedding
  - Small vector preview toggle (truncated) with dimensionality
- Search defaults to the selected embedding set when available
- Coverage semantics fixed: it now counts only rows with matching set and non‑null embeddings
- Worker write path fix
  - When pgvector is available, the worker writes embeddings using `::vector` casting; otherwise writes text

All current unit tests pass and smoke checks on desktop/web are green.

---

## How to Run and Validate

Repo‑wide:
- Install: `pnpm install`
- Build: `pnpm -w build`
- Tests (spot): `pnpm -w test --filter @brainstrike/app-shell -- --run`

Desktop app:
- Start: `pnpm dev --filter @brainstrike/desktop`
- Right Panel → DB:
  - Vector Status shows pgvector: on, worker: running
  - Import or click Backfill Active Set; queue counts move; coverage rises; chunks auto‑refresh

Web app:
- Start: `pnpm dev --filter @brainstrike/web`
- Right Panel → DB: Start/Stop the local worker (web), pick Embedding Set, Backfill, and monitor queue/metrics. Settings no longer contains separate worker controls to avoid duplication.

Smoke checklist:
- Select an embedding set, import a small folder
- Watch queue drain; coverage increases; chunk badges switch to “embedded” without manual refresh
- Run a search; results return with similarity in [0,1]; search scopes to the selected set

---

## Files Touched (pointers)

Core UI and helpers
- packages/app-shell/src/vector-status.tsx
  - Embedding set selector, coverage, throughput, backfill + progress, auto‑refresh on drain
- packages/app-shell/src/database-demo/components/chunks-view.tsx
  - Set‑aware badges, vector preview
- packages/app-shell/src/database-demo-panel.tsx
  - Listens for `brainstrike:queue-drained` and auto‑refreshes chunk list
- packages/app-shell/src/database-demo/hooks/use-search-functionality.ts
  - Search scoping to selected set; simplified error handling; reduced complexity
- packages/app-shell/src/vector-preferences.ts
  - Local persistence for the selected embedding set id

DB/worker changes
- packages/embeddings/src/worker/embedding-worker.ts
  - Writes vectors with `::vector` when pgvector is available; text otherwise
- packages/db/src/repositories/file-chunk-repository.ts
  - Coverage now counts `embedding_set_id = $1 AND embedding IS NOT NULL`
- packages/db/src/db-provider.tsx
  - IPC path exposes minimal DB handle in renderer; sets `vectorEnabled` for Vector Status

Docs
- ./PHASE_4_HANDOFF.md (updated objectives/tasks for Phase 6)
- ../09-05-2025-db-embedding-modernization-2025.md (Phase 6 tasks/validation progress)

---

## Notable Design Choices

- “Selected set” is the UX term for the currently active Embedding Set ID used by:
  - Search scoping (default)
  - Coverage x/y in Vector Status
  - Backfill Active Set enqueue logic
  - Chunk badges (embedded for selected vs other sets)
- Backfill prioritizes UX clarity and correctness:
  - Skips chunks already queued/running for the set via a NOT EXISTS check
  - Batches enqueues (commit every ~500) with a live progress indicator
  - Uses dedupe keys `chunkId:setId:contentHash` to avoid duplicate active jobs
- Auto‑refresh is event‑based to avoid tight polling: when queue drains (Q+R → 0), an event is dispatched and chunk views refresh

— Web UX consolidation (2025‑08‑31):
- To match Desktop and reduce cognitive load, all vector/worker operations live in the DB tab’s Vector Status. The web Settings page no longer contains separate worker controls. On Web, the worker badge shows `disabled` until the user explicitly starts the local worker; once jobs are active (backfill/import), it transitions to `running`.

---

## Known Limitations / Follow‑ups

- Backfill scalability
  - The current batched approach performs well into tens of thousands; for larger sets, consider a single SQL insert‑select with deterministic job IDs (e.g. `job.id = chunkId:setId`) to avoid per‑row round trips
- DTO docs still need to be added
  - `ChunkSearchOptions`, `ChunkSearchResult`, `EmbeddingSet`, `Job` (public) shapes
- Search scoping is implemented in the demo path; apply across all UI entry points if needed
- If enabling distances beyond cosine, ensure matching indexes are installed for pgvector (e.g., HNSW with correct ops)

---

## Practical Next Steps (suggested owner: next dev)

Short‑term (Phase 6 polish)
1) Finish DTO docs and APIs
   - Add a docs section with the canonical shapes and examples
   - Ensure `@brainstrike/db` exports are consistent
2) Optional: “Fast Backfill (SQL)” button
   - Insert‑select all missing jobs for the selected set in one shot
   - Use deterministic job IDs (e.g., `chunkId:setId`) to avoid needing UUID generation in SQL
   - Keep the current button as a safe fallback
3) Optional: add UI to cancel backfill or pause worker
4) Add UI tests for the new badges and Vector Status progress

Medium‑term (Phase 7 preview)
1) Lightweight metrics
   - Queue depth over time, job latency, embeddings/sec (log or in‑app counters)
2) Perf scenario for Playwright
   - Import a medium repo and record TTI for first search with/without worker running
3) Turbo graph updates / cache where safe (tests/builds)

---

## Troubleshooting

- Vector Status says pgvector: off on desktop
  - Ensure `@electric-sql/pglite/vector` is bundled; desktop hard‑requires pgvector and will fail DB init otherwise
- Chunks don’t show embedded after jobs succeed
  - Click Backfill; watch progress; when queue drains, chunks auto‑refresh
  - If still not visible, click Refresh in the demo panel (there may be a race in your local run)
- Web: pgvector stays off
  - That’s expected by default; web uses client‑side cosine by design (see Appendix in `../09-05-2025-db-embedding-modernization-2025.md`)

---

## Handy Commands

Build + test quickly
```
pnpm -s run check
# or headless
pnpm -s run check:headless
```

App Shell only
```
pnpm -w test --filter @brainstrike/app-shell -- --run
```

Desktop dev
```
pnpm dev --filter @brainstrike/desktop
```

Web dev
```
pnpm dev --filter @brainstrike/web
```

---

## Quick File Map

- packages/app-shell/src/vector-status.tsx
- packages/app-shell/src/database-demo/components/chunks-view.tsx
- packages/app-shell/src/database-demo-panel.tsx
- packages/app-shell/src/database-demo/hooks/use-search-functionality.ts
- packages/app-shell/src/vector-preferences.ts
- packages/embeddings/src/worker/embedding-worker.ts
- packages/db/src/repositories/file-chunk-repository.ts
- packages/db/src/db-provider.tsx

---

Handoff complete — the UX and worker paths are in a solid place. Finish the DTO docs, consider fast backfill for very large sets, and start the Phase 7 perf/observability work.
