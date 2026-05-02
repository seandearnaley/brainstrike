---
title: "PGlite Browser Storage Backend Analysis"
sidebar_position: 10
---

# PGlite Browser Storage Backend Analysis

This note records the current IndexedDB vs OPFS AHP decision for Brainstrike Web.

## Decision

Use `idb://app` as the default browser PGlite data directory.

Support `opfs-ahp://app` as an explicit opt-in only when the browser has Worker
support and `navigator.storage.getDirectory`. Unsupported OPFS requests must
fall back to IndexedDB instead of failing web startup.

## Rationale

PGlite's current filesystem documentation recommends IndexedDB in browsers
because OPFS AHP is not supported by Safari. IndexedDB is slower for write-heavy
workloads because it loads database files into memory and flushes changed files
to IndexedDB, but it is the only cross-browser persistent default.

OPFS AHP is promising for Chrome and Firefox because it runs from a worker and
uses a synchronous access-handle pool. Brainstrike now owns web PGlite in a
PGliteWorker host, so the worker-only OPFS constraint is no longer an
architectural blocker.

## Benchmark Harness

The benchmark harness lives in
`packages/db/src/browser-pglite-storage-benchmark.ts`.

It compares selected storage backends with these Brainstrike-shaped operations:

- bootstrap a small schema with a vector column and HNSW index
- insert file records
- insert chunk records with vectors
- run an aggregate count query
- run a vector nearest-neighbor query

The harness is intentionally adapter-based so the web app can create isolated
benchmark clients with `wasmLoader.createPGliteClient()` and close them after
each backend run.

The worker host sets `relaxedDurability: true` for IndexedDB and
`relaxedDurability: false` for OPFS AHP. This is intentional: IndexedDB needs the
relaxed write path to avoid blocking on whole-file flushes, while OPFS AHP is an
experimental opt-in backend and should benchmark against explicit strict
durability unless a future measured change says otherwise.

## Current Recommendation

Keep IndexedDB as default. Use OPFS AHP only for explicit local experiments or a
future browser capability setting after measured deltas justify it.

Because Brainstrike is greenfield, no user-data migration blocks a future default
change. The remaining gate is product quality: startup reliability, reset
behavior, Safari fallback, and measured performance wins on real backfill/search
workloads.
