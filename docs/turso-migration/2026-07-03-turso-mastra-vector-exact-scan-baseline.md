# Turso Mastra Vector Exact-Scan Baseline

**Date**: 2026-07-03
**Source commit**: `914201922+working-tree`
**Reproducer**: `pnpm --filter @brainstrike/agent run bench:turso-vector-memory -- --rows 5000 --dimensions 384 --queries 12 --warmup 2 --top-k 8 --out ../../docs/turso-migration/2026-07-03-turso-mastra-vector-exact-scan-baseline.md`

## Verdict

The current Turso Mastra vector-memory path is characterized as an exact scan over `mastra_vectors` for 5000 rows at 384 dimensions. The benchmark matched the independent scorer for 12/12 queries, with recall@K 1.000.

Native Turso vector indexes remain a separate decision because the current store preserves exact ordering semantics, supports dot-product metrics, and applies Mastra metadata filters through the shared table before `LIMIT`.

## Input

| field | value |
| --- | ---: |
| rows | 5000 |
| dimensions | 384 |
| topK | 8 |
| measured queries | 12 |
| warmup queries | 2 |
| metric | cosine |

## Query Shape

| field | value |
| --- | --- |
| path | exact-scan |
| metadataFilter | json_extract |
| usesVectorDistance | true |
| usesVectorTopK | false |

## Turso Docs Context

- [Turso Vector Search](https://docs.turso.tech/guides/vector-search) documents native vector values and distance functions for SQL similarity search.
- [Turso AI & Embeddings](https://docs.turso.tech/features/ai-and-embeddings) documents `libsql_vector_idx` / `vector_top_k` as an explicit indexed vector-search path, which this benchmark does not use.
- [Turso TypeScript Quickstart](https://docs.turso.tech/sdk/ts/quickstart) names `@tursodatabase/database` as the recommended local/embedded package for Node and Electron.

## Timings

| metric | ms |
| --- | ---: |
| seed | 480.763 |
| query min | 19.109 |
| query p50 | 24.185 |
| query p95 | 30.411 |
| query max | 30.411 |
| query mean | 24.664 |

## Query Plan

- `SEARCH mastra_vectors USING INDEX mastra_vectors_updated_idx (index_name=?)`
- `SCAN q`
- `SCAN CONSTANT ROW`
- `USE SORTER FOR ORDER BY`

## Runtime

- Database: `@tursodatabase/database`
- Journal mode: `mvcc`

## Follow-Up Trigger

If expected profile sizes push exact-scan p95 beyond the team latency budget, evaluate a separate schema/index PR for `libsql_vector_idx` / `vector_top_k` with explicit recall-quality acceptance tests.

