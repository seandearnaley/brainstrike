# Token Cache Architecture Proposal

**Date**: 2025-12-06
**Author**: Claude Code
**Status**: Proposal

## Executive Summary

This proposal addresses the critical performance bottleneck when loading directories with 17k+ files. The current architecture loads file contents into memory for all selected files and counts tokens on the main thread, causing UI freezes and memory pressure.

The proposed solution introduces:
1. **Lazy content loading** - Only load content for files being actively viewed/selected
2. **Persistent token cache** with content-based invalidation using xxHash
3. **Background Web Worker** for non-blocking token counting
4. **PGlite integration** for SQLite-based persistent storage

## Problem Analysis

### Current Architecture Issues

```
Current Flow (Problematic):
┌──────────────┐    ┌────────────────┐    ┌─────────────────┐
│ File Select  │───►│ Load Content   │───►│ Count Tokens    │
│ (any file)   │    │ (main thread)  │    │ (main thread)   │
└──────────────┘    └────────────────┘    └─────────────────┘
                            │                      │
                            ▼                      ▼
                    ┌────────────────┐    ┌─────────────────┐
                    │ Store in RAM   │    │ Recount Every   │
                    │ (LRU 5MB/50)   │    │ Session         │
                    └────────────────┘    └─────────────────┘
```

**Key Problems Identified:**

1. **Memory Pressure**: `file-content-cache.ts` stores file contents in memory (LRU cache limited to 5MB/50 files), but UI still needs to process metadata for 17k files
2. **Main Thread Blocking**: Token counting via `countTokensAccurate()` uses tiktoken WASM on main thread
3. **No Persistence**: Token counts stored in React refs (`tokenCacheRef`), lost on unmount
4. **Inefficient Re-computation**: Same files re-counted every session regardless of changes

### Data Flow Analysis

From `use-preview-panel-state.ts:76-110`:
```typescript
function ensureTokenCount(compositeKey, content, tokenCounting, ...) {
  // Checks in-memory cache first
  const cached = tokenCacheRef.current.get(compositeKey);
  if (typeof cached === 'number') return cached;

  // If not cached, triggers async token count ON MAIN THREAD
  const pending = tokenCounting.countTokens(content)  // <-- Blocks UI
    .then((count) => tokenCacheRef.current.set(compositeKey, count))
}
```

## Proposed Architecture

### High-Level Design

```
New Flow (Optimized):
┌──────────────┐    ┌────────────────┐    ┌─────────────────┐
│ File Tree    │───►│ Check PGlite   │───►│ Return Cached   │
│ Display      │    │ Token Cache    │    │ Token Count     │
└──────────────┘    └────────────────┘    └─────────────────┘
                            │ Cache Miss
                            ▼
┌──────────────┐    ┌────────────────┐    ┌─────────────────┐
│ File Select  │───►│ Queue Token    │───►│ Web Worker      │
│ (explicit)   │    │ Count Job      │    │ Background      │
└──────────────┘    └────────────────┘    └─────────────────┘
                                                   │
                                                   ▼
                                          ┌─────────────────┐
                                          │ Store: PGlite   │
                                          │ + xxHash + mtime│
                                          └─────────────────┘
```

### Component Architecture

```
packages/
├── token-cache/                    # New package
│   ├── src/
│   │   ├── index.ts               # Public API
│   │   ├── token-cache-store.ts   # PGlite repository
│   │   ├── token-cache-worker.ts  # Web Worker for counting
│   │   ├── file-hasher.ts         # xxHash integration
│   │   ├── cache-invalidation.ts  # Change detection logic
│   │   └── types.ts               # Type definitions
│   └── package.json
```

### Database Schema (PGlite)

```sql
-- New table in existing PGlite database
CREATE TABLE IF NOT EXISTS file_token_cache (
    id SERIAL PRIMARY KEY,
    folder_id TEXT NOT NULL,           -- Root folder identifier
    file_path TEXT NOT NULL,           -- Relative file path
    content_hash TEXT NOT NULL,        -- xxHash64 of content
    file_size BIGINT NOT NULL,         -- Size in bytes
    mtime_ms BIGINT,                   -- File modification time (ms)
    token_count INTEGER NOT NULL,      -- Cached token count
    counting_mode TEXT NOT NULL,       -- 'accurate' | 'heuristic'
    model_encoding TEXT,               -- e.g., 'o200k_base' for accurate
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(folder_id, file_path)
);

CREATE INDEX idx_token_cache_lookup ON file_token_cache(folder_id, file_path);
CREATE INDEX idx_token_cache_hash ON file_token_cache(content_hash);
```

### Content Hashing Strategy

Using [xxhash-wasm](https://www.npmjs.com/package/xxhash-wasm) for fast, non-cryptographic hashing:

```typescript
// file-hasher.ts
import xxhash from 'xxhash-wasm';

export class FileHasher {
  private hasher: Awaited<ReturnType<typeof xxhash>> | null = null;

  async init(): Promise<void> {
    if (!this.hasher) {
      this.hasher = await xxhash();
    }
  }

  /**
   * Fast hash for cache invalidation.
   * xxHash64 is ~20x faster than SHA-256 for this use case.
   */
  async hashContent(content: string): Promise<string> {
    await this.init();
    return this.hasher!.h64(content);
  }

  /**
   * Quick validation using metadata only (no content read required).
   * Returns true if file may have changed.
   */
  shouldRevalidate(
    cachedMtime: number,
    cachedSize: number,
    currentMtime: number,
    currentSize: number
  ): boolean {
    return cachedMtime !== currentMtime || cachedSize !== currentSize;
  }
}
```

### Token Counting Worker

```typescript
// token-cache-worker.ts
/// <reference lib="webworker" />
import { worker, workerEmit } from 'workerpool';
import xxhash from 'xxhash-wasm';

type TokenCountRequest = {
  id: string;
  content: string;
  mode: 'accurate' | 'heuristic';
};

type TokenCountResult = {
  id: string;
  tokenCount: number;
  contentHash: string;
  mode: 'accurate' | 'heuristic';
};

let hasher: Awaited<ReturnType<typeof xxhash>> | null = null;

async function initHasher() {
  if (!hasher) {
    hasher = await xxhash();
  }
  return hasher;
}

async function countTokensInWorker(
  request: TokenCountRequest
): Promise<TokenCountResult> {
  const h = await initHasher();
  const contentHash = h.h64(request.content);

  // Import token counting dynamically to keep worker lean
  const { countTokensAccurate, countTokensHeuristic } = await import('@brainstrike/utils');

  const tokenCount = request.mode === 'accurate'
    ? await countTokensAccurate(request.content)
    : countTokensHeuristic(request.content);

  return {
    id: request.id,
    tokenCount,
    contentHash,
    mode: request.mode,
  };
}

// Batch processing for efficiency
async function countTokensBatch(
  requests: TokenCountRequest[]
): Promise<TokenCountResult[]> {
  const results: TokenCountResult[] = [];

  for (let i = 0; i < requests.length; i++) {
    const result = await countTokensInWorker(requests[i]);
    results.push(result);

    // Emit progress for UI updates
    workerEmit({
      type: 'progress',
      completed: i + 1,
      total: requests.length,
    });
  }

  return results;
}

worker({
  countTokens: countTokensInWorker,
  countTokensBatch,
});
```

### Cache Store API

```typescript
// token-cache-store.ts
import type { PGlite } from '@electric-sql/pglite';

export type TokenCacheEntry = {
  folderId: string;
  filePath: string;
  contentHash: string;
  fileSize: number;
  mtimeMs: number | null;
  tokenCount: number;
  countingMode: 'accurate' | 'heuristic';
  modelEncoding: string | null;
};

export class TokenCacheStore {
  constructor(private readonly db: PGlite) {}

  /**
   * Get cached token count if valid
   */
  async get(
    folderId: string,
    filePath: string
  ): Promise<TokenCacheEntry | null> {
    const result = await this.db.query<TokenCacheEntry>(
      `SELECT * FROM file_token_cache
       WHERE folder_id = $1 AND file_path = $2`,
      [folderId, filePath]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Get token counts for multiple files in single query
   */
  async getBatch(
    folderId: string,
    filePaths: string[]
  ): Promise<Map<string, TokenCacheEntry>> {
    if (filePaths.length === 0) return new Map();

    const placeholders = filePaths.map((_, i) => `$${i + 2}`).join(',');
    const result = await this.db.query<TokenCacheEntry>(
      `SELECT * FROM file_token_cache
       WHERE folder_id = $1 AND file_path IN (${placeholders})`,
      [folderId, ...filePaths]
    );

    return new Map(result.rows.map(row => [row.filePath, row]));
  }

  /**
   * Upsert token cache entry
   */
  async set(entry: TokenCacheEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO file_token_cache
       (folder_id, file_path, content_hash, file_size, mtime_ms,
        token_count, counting_mode, model_encoding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (folder_id, file_path)
       DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         file_size = EXCLUDED.file_size,
         mtime_ms = EXCLUDED.mtime_ms,
         token_count = EXCLUDED.token_count,
         counting_mode = EXCLUDED.counting_mode,
         model_encoding = EXCLUDED.model_encoding,
         updated_at = NOW()`,
      [
        entry.folderId,
        entry.filePath,
        entry.contentHash,
        entry.fileSize,
        entry.mtimeMs,
        entry.tokenCount,
        entry.countingMode,
        entry.modelEncoding,
      ]
    );
  }

  /**
   * Batch upsert for efficiency
   */
  async setBatch(entries: TokenCacheEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Use transaction for atomicity
    await this.db.query('BEGIN');
    try {
      for (const entry of entries) {
        await this.set(entry);
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * Clear cache for a folder (when folder is removed)
   */
  async clearFolder(folderId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM file_token_cache WHERE folder_id = $1`,
      [folderId]
    );
  }

  /**
   * Get aggregate token count for selected files
   */
  async getTotalTokens(
    folderId: string,
    filePaths: string[]
  ): Promise<number> {
    if (filePaths.length === 0) return 0;

    const placeholders = filePaths.map((_, i) => `$${i + 2}`).join(',');
    const result = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(token_count), 0) as total
       FROM file_token_cache
       WHERE folder_id = $1 AND file_path IN (${placeholders})`,
      [folderId, ...filePaths]
    );

    return Number(result.rows[0]?.total ?? 0);
  }
}
```

### React Hook Integration

```typescript
// use-token-cache.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pool } from 'workerpool';
import type { TokenCacheStore, TokenCacheEntry } from './token-cache-store';
import type { FileHasher } from './file-hasher';

export type TokenCacheState = {
  /** Get token count for a file (from cache or triggers background count) */
  getTokenCount: (folderId: string, filePath: string, content?: string) => number | null;
  /** Get aggregated token count for selected files */
  getTotalTokens: (folderId: string, filePaths: string[]) => Promise<number>;
  /** Check if token count is loading for a file */
  isLoading: (folderId: string, filePath: string) => boolean;
  /** Queue files for background token counting */
  queueForCounting: (requests: Array<{
    folderId: string;
    filePath: string;
    content: string;
    fileSize: number;
    mtimeMs?: number;
  }>) => void;
};

export function useTokenCache(
  store: TokenCacheStore,
  hasher: FileHasher,
  workerPool: Pool,
  countingMode: 'accurate' | 'heuristic'
): TokenCacheState {
  // In-memory cache for immediate access (hot cache)
  const memoryCache = useRef(new Map<string, number>());
  const pendingRequests = useRef(new Set<string>());
  const [version, setVersion] = useState(0);

  const getCacheKey = (folderId: string, filePath: string) =>
    `${folderId}::${filePath}`;

  const getTokenCount = useCallback((
    folderId: string,
    filePath: string,
    content?: string
  ): number | null => {
    const key = getCacheKey(folderId, filePath);

    // Check hot cache first
    const cached = memoryCache.current.get(key);
    if (cached !== undefined) return cached;

    // If content provided and not pending, queue for counting
    if (content && !pendingRequests.current.has(key)) {
      // Async load from PGlite, then worker if needed
      void loadOrCount(folderId, filePath, content);
    }

    return null; // Loading
  }, [store, hasher, workerPool, countingMode]);

  const loadOrCount = async (
    folderId: string,
    filePath: string,
    content: string
  ) => {
    const key = getCacheKey(folderId, filePath);
    pendingRequests.current.add(key);

    try {
      // Check persistent cache
      const cached = await store.get(folderId, filePath);
      const contentHash = await hasher.hashContent(content);

      if (cached && cached.contentHash === contentHash &&
          cached.countingMode === countingMode) {
        // Cache hit - content unchanged
        memoryCache.current.set(key, cached.tokenCount);
        setVersion(v => v + 1);
        return;
      }

      // Cache miss or stale - count in worker
      const result = await workerPool.exec('countTokens', [{
        id: key,
        content,
        mode: countingMode,
      }]);

      // Store in persistent cache
      await store.set({
        folderId,
        filePath,
        contentHash: result.contentHash,
        fileSize: new Blob([content]).size,
        mtimeMs: Date.now(),
        tokenCount: result.tokenCount,
        countingMode,
        modelEncoding: countingMode === 'accurate' ? 'o200k_base' : null,
      });

      // Update hot cache
      memoryCache.current.set(key, result.tokenCount);
      setVersion(v => v + 1);
    } finally {
      pendingRequests.current.delete(key);
    }
  };

  const isLoading = useCallback((folderId: string, filePath: string) => {
    return pendingRequests.current.has(getCacheKey(folderId, filePath));
  }, []);

  const getTotalTokens = useCallback(async (
    folderId: string,
    filePaths: string[]
  ) => {
    return store.getTotalTokens(folderId, filePaths);
  }, [store]);

  const queueForCounting = useCallback((requests: Array<{
    folderId: string;
    filePath: string;
    content: string;
    fileSize: number;
    mtimeMs?: number;
  }>) => {
    for (const req of requests) {
      void loadOrCount(req.folderId, req.filePath, req.content);
    }
  }, []);

  return {
    getTokenCount,
    getTotalTokens,
    isLoading,
    queueForCounting,
  };
}
```

## Key Design Decisions

### 1. Why PGlite over IndexedDB?

- Already used in the project for embeddings/chunks
- SQL queries for aggregations (`SUM(token_count)`)
- ACID transactions for batch operations
- Familiar API for the team
- Better query performance for large datasets ([source](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/))

### 2. Why xxHash over SHA-256?

- **20x faster** than cryptographic hashes
- Non-cryptographic is fine for cache invalidation (we don't need collision resistance)
- WASM implementation available ([xxhash-wasm](https://github.com/jungomi/xxhash-wasm))
- 64-bit hash is sufficient for file deduplication

### 3. Why Web Worker for Token Counting?

- tiktoken WASM encoding can block main thread for 10-50ms per file
- Worker keeps UI responsive during batch operations
- Existing workerpool infrastructure in the project
- Progressive UI updates via `workerEmit`

### 4. Two-Level Caching Strategy

1. **Hot Cache (Memory)**: `Map<string, number>` for instant access
2. **Cold Cache (PGlite)**: Persistent across sessions

This provides:
- Sub-millisecond reads for recently accessed files
- Persistence across browser restarts
- Efficient aggregation queries

## Migration Plan

### Phase 1: Database Migration (Week 1)
1. Add `file_token_cache` table to PGlite migrations
2. Add repository class `TokenCacheRepository`
3. Unit tests for repository

### Phase 2: Worker Implementation (Week 1-2)
1. Create `token-cache-worker.ts`
2. Integrate xxhash-wasm for content hashing
3. Port existing token counting logic to worker
4. Integration tests

### Phase 3: React Integration (Week 2)
1. Create `useTokenCache` hook
2. Update `use-preview-panel-state.ts` to use new cache
3. Update `use-token-counting.ts` to support worker mode
4. E2E tests for performance

### Phase 4: Content Loading Optimization (Week 3)
1. Modify `use-shared-file-content-loading.ts` to only load selected files
2. Remove eager content loading for 17k files
3. Performance testing and profiling

## Performance Expectations

| Scenario | Current | Proposed |
|----------|---------|----------|
| Initial load (17k files) | ~30s freeze | < 1s (metadata only) |
| Token count (cached) | N/A | < 1ms (memory) |
| Token count (PGlite) | N/A | < 10ms |
| Token count (worker) | 10-50ms (blocking) | 10-50ms (non-blocking) |
| Memory usage | ~50MB (contents) | ~5MB (cache only) |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| PGlite performance with 17k rows | Use indexes, batch queries, periodic VACUUM |
| Worker initialization overhead | Lazy load, keep worker alive |
| xxhash WASM load time | Cache WASM instance, ~1ms browser |
| Cache staleness on external edits | Use file mtime + size as quick check |

## Dependencies

New npm packages:
- `xxhash-wasm`: Fast non-cryptographic hashing ([npm](https://www.npmjs.com/package/xxhash-wasm))
- Already have: `workerpool`, `@electric-sql/pglite`, tiktoken

## References

- [Offline-First Frontend Apps 2025](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)
- [Web Workers Best Practices](https://dev.to/mino/unlocking-performance-a-comprehensive-guide-to-web-workers-25i7)
- [xxHash WASM Performance](https://github.com/jungomi/xxhash-wasm)
- [RxDB IndexedDB Performance](https://rxdb.info/slow-indexeddb.html)

## Appendix: Alternative Approaches Considered

### A. IndexedDB Direct (Rejected)
- Pro: No additional dependency
- Con: No SQL aggregations, verbose API, slower for complex queries

### B. Content-Based Addressing Only (Rejected)
- Pro: Simpler invalidation
- Con: Requires reading entire file to check validity

### C. File System Access API `watch()` (Rejected)
- Pro: Real-time invalidation
- Con: Not supported in all browsers, complexity overhead
