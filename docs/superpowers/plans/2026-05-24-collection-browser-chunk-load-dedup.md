# Collection Browser Chunk Load Dedup Plan

## Source

Follow-up from `docs/handoff-simplification-remaining.md` (Item 2).

## Problem

`ensureFileChunksLoaded` had no in-flight deduplication. Rapid expand-all clicks could
issue duplicate `loadFileChunkSummaries` requests for the same file before the first
request resolved.

## Fix

Track in-flight loads in a `Map<fileRecordId, Promise<...>>` ref. Reuse the pending
promise for concurrent callers and clear the map entry in `finally`.

## TDD

1. RED: expand-all clicked twice while load is pending → expect one fetch call.
2. GREEN: implement ref-backed dedup in `collection-browser-view.tsx`.

## Validation

- `pnpm --dir packages/db-explorer exec vitest run src/components/__tests__/collection-browser-view.test.ts`
