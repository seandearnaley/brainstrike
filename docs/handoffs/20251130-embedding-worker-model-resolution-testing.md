# Handoff: Embedding Worker Model Resolution Testing

**Date**: 2025-11-30  
**Author**: AI Assistant  
**Status**: Completed - follow-up tickets created  
**Priority**: High  
**Estimated Effort**: 4-6 hours

## Summary

We fixed a critical bug where local embedding models stopped working after transitioning from a static registry to database-driven model configuration. The system now uses **HuggingFace IDs everywhere** (e.g., `jinaai/jina-embeddings-v2-base-code`) - no more short keys like `jina-code`. The static registry is marked deprecated and will be removed via follow-up tickets.

### Follow-up Work Items

| Ticket | Summary |
|--------|---------|
| **BST-72** | Epic: Remove static model registry - migrate all model lookups to database |
| **BST-73** | Update embedding-settings-section.tsx to use database model store |
| **BST-74** | Update db-explorer to use database for model list |
| **BST-75** | Update file-import enhanced-import.ts to use database model lookup |
| **BST-76** | Update CLI embed-code.ts to use database or accept model config |
| **BST-77** | Update tests to use mock database or test fixtures |
| **BST-78** | Final cleanup - remove static model registry and deprecated methods |

## Background & Root Cause

### The Problem
Users reported that ALL local embedding models failed with unhelpful errors like:
- `"Hosted provider 'transformers' is not supported yet."`
- `"Model 'jina-code' not found in database."`
- `"Workerpool Worker error: Unknown worker error"`

### Root Causes Identified

1. **Provider Type Classification**: The `transformers` provider was not recognized as a local provider type, causing it to be routed to the hosted provider path.

2. **Model ID Mismatch**: The static registry originally used short keys (`jina-code`, `all-MiniLM-L6-v2`), but the database stores models by HuggingFace ID (`jinaai/jina-embeddings-v2-base-code`, `Xenova/all-MiniLM-L6-v2`).

3. **Error Serialization**: Error objects weren't being serialized properly in logs, showing `{}` instead of the actual error message.

### The Fix (Final Implementation)

1. Added `'transformers'` to `EmbeddingProviderType` union and created `LocalProviderType` / `HostedProviderType` aliases
2. Added `isLocalProviderType()` helper function
3. **Changed static registry to use HuggingFace IDs as keys** (e.g., `jinaai/jina-embeddings-v2-base-code` instead of `jina-code`)
4. **Changed default model key** from `jina-code` to `jinaai/jina-embeddings-v2-base-code`
5. **Removed translation layer** - `getModelConfigFromDb()` now queries database directly with HuggingFace IDs
6. **Marked static methods as deprecated** - `SimpleEmbeddingService.getDefaultModelKey()`, `getModelConfig()`, etc.
7. Fixed error logging to extract `message` and `stack` from Error objects
8. Added comprehensive logging throughout the embedding worker lifecycle
9. Removed noisy polling log (`processBatch: no jobs to claim`)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RENDERER PROCESS                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  EmbeddingWorkerProvider (React Component)                          │
│       │                                                              │
│       └──► startEmbeddingWorker(options)                            │
│                 │                                                    │
│                 ├──► initializeEmbeddingService()                   │
│                 │         │                                          │
│                 │         ├──► getModelConfigFromDb() ◄──────────┐  │
│                 │         │         │                             │  │
│                 │         │         └──► db.query('models')       │  │
│                 │         │              (uses HuggingFace ID     │  │
│                 │         │               directly - no          │  │
│                 │         │               translation needed)     │  │
│                 │         │                                       │  │
│                 │         └──► SimpleEmbeddingService             │  │
│                 │              .initializeWithModel(config)       │  │
│                 │                                                 │  │
│                 └──► processBatch() loop                          │  │
│                           │                                       │  │
│                           ├──► jq.claimMany() (get jobs)         │  │
│                           │                                       │  │
│                           ├──► generateEmbeddingsForGroup()      │  │
│                           │         │                             │  │
│                           │         ├──► ensureLocalModel() ─────┘  │
│                           │         │    (may re-query DB for       │
│                           │         │     different model)          │
│                           │         │                               │
│                           │         └──► TransformersBackend        │
│                           │              (workerpool Web Workers)   │
│                           │                                         │
│                           └──► handleBatchFailure() (on error)     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Note**: The static `ModelRegistryManager` is now deprecated and not used in the main runtime path. All model configuration comes from the database. The static registry remains only for backwards compatibility with CLI/tests and will be removed in BST-78.

## Key Files

| File | Purpose |
|------|---------|
| `packages/embeddings/src/worker/embedding-worker.ts` | Main embedding worker - job processing, model initialization |
| `packages/embeddings/src/provider-types.ts` | Provider type definitions (`LocalProviderType`, `HostedProviderType`) |
| `packages/embeddings/src/provider-utils.ts` | `isHostedProvider()`, `parseProviderModelKey()` |
| `packages/embeddings/src/model-registry.ts` | Static registry fallback (HuggingFace IDs; legacy short keys are deprecated) |
| `packages/db/src/migrations/015-model-registry.ts` | Database seed data for models table |
| `apps/desktop/src/renderer/components/embedding-worker-provider.tsx` | React component that starts the worker |
| `packages/queue/src/adapters/browser-workerpool.ts` | Workerpool adapter for Web Workers |
| `packages/embedding-worker/src/embedding.worker.ts` | Actual Web Worker running transformers.js |

## Test Cases to Add

### 1. Provider Type Classification Tests

**File**: `packages/embeddings/src/__tests__/provider-types.test.ts` (create if doesn't exist)

```typescript
describe('isLocalProviderType', () => {
  it('returns true for "local" provider', () => {
    expect(isLocalProviderType('local')).toBe(true);
  });

  it('returns true for "transformers" provider', () => {
    expect(isLocalProviderType('transformers')).toBe(true);
  });

  it('returns false for hosted providers', () => {
    expect(isLocalProviderType('openai')).toBe(false);
    expect(isLocalProviderType('google')).toBe(false);
    expect(isLocalProviderType('cohere')).toBe(false);
    expect(isLocalProviderType('voyage')).toBe(false);
  });
});

describe('isHostedProvider', () => {
  it('returns false for local providers', () => {
    expect(isHostedProvider('local')).toBe(false);
    expect(isHostedProvider('transformers')).toBe(false);
  });

  it('returns true for hosted providers', () => {
    expect(isHostedProvider('openai')).toBe(true);
    expect(isHostedProvider('google')).toBe(true);
  });
});
```

### 2. Model Registry Key Resolution Tests

**File**: `packages/embeddings/src/__tests__/model-registry.test.ts` (enhance existing)

> **Note**: The registry now uses HuggingFace IDs as keys. Short keys like `jina-code` are no longer used.

```typescript
describe('getModel with HuggingFace IDs', () => {
  // HuggingFace IDs are now the primary keys
  it('resolves full HuggingFace ID directly', () => {
    const model = ModelRegistryManager.getModel('jinaai/jina-embeddings-v2-base-code');
    expect(model?.id).toBe('jinaai/jina-embeddings-v2-base-code');
  });

  it('resolves Xenova model ID', () => {
    const model = ModelRegistryManager.getModel('Xenova/all-MiniLM-L6-v2');
    expect(model?.id).toBe('Xenova/all-MiniLM-L6-v2');
  });

  // Composite keys with provider prefix
  it('resolves "transformers::Xenova/all-MiniLM-L6-v2"', () => {
    const model = ModelRegistryManager.getModel('transformers::Xenova/all-MiniLM-L6-v2');
    expect(model?.id).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('resolves "local::jinaai/jina-embeddings-v2-base-code"', () => {
    const model = ModelRegistryManager.getModel('local::jinaai/jina-embeddings-v2-base-code');
    expect(model?.id).toBe('jinaai/jina-embeddings-v2-base-code');
  });

  it('returns default model key as HuggingFace ID', () => {
    const defaultKey = ModelRegistryManager.getDefaultModelKey();
    expect(defaultKey).toBe('jinaai/jina-embeddings-v2-base-code');
  });
});
```

### 3. Database Model Lookup Tests

**File**: `packages/embeddings/src/__tests__/embedding-worker-db-lookup.test.ts` (create new)

```typescript
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '@brainstrike/db';

describe('getModelConfigFromDb', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await PGlite.create('memory://');
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('finds model by HuggingFace ID', async () => {
    // Query directly - model should exist from migration seed data
    const result = await db.query(
      "SELECT id, name FROM models WHERE id = 'Xenova/all-MiniLM-L6-v2'"
    );
    expect(result.rows.length).toBe(1);
  });

  it('does NOT find model by registry short key (without translation)', async () => {
    const result = await db.query(
      "SELECT id FROM models WHERE id = 'all-MiniLM-L6-v2'"
    );
    expect(result.rows.length).toBe(0); // Short key not in DB
  });

  // Integration test: getModelConfigFromDb should translate and find
  it('getModelConfigFromDb translates registry key before querying', async () => {
    // This would require exposing getModelConfigFromDb or testing through
    // startEmbeddingWorker - see integration test section
  });
});
```

### 4. Embedding Worker Integration Tests

**File**: `packages/embeddings/src/__tests__/embedding-worker-model-resolution.integration.test.ts` (create new)

```typescript
import { PGlite } from '@electric-sql/pglite';
import { migrate, JobQueue } from '@brainstrike/db';
import { startEmbeddingWorker, clearModelConfigCache } from '../worker/embedding-worker';

describe('Embedding Worker Model Resolution', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await PGlite.create('memory://');
    await migrate(db);
    clearModelConfigCache(); // Clear cache between tests
  });

  afterEach(async () => {
    await db.close();
  });

  describe('worker initialization with HuggingFace model IDs', () => {
    it('starts with HuggingFace ID "jinaai/jina-embeddings-v2-base-code"', async () => {
      const worker = await startEmbeddingWorker({
        db,
        modelKey: 'jinaai/jina-embeddings-v2-base-code',
        enable: true,
        // Use a mock service to avoid actual model loading
        service: createMockEmbeddingService(768),
      });
      
      expect(worker).toBeDefined();
      await worker.stop();
    });

    it('starts with composite key "transformers::Xenova/all-MiniLM-L6-v2"', async () => {
      const worker = await startEmbeddingWorker({
        db,
        modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
        enable: true,
        service: createMockEmbeddingService(384),
      });
      
      expect(worker).toBeDefined();
      await worker.stop();
    });

    it('starts with default model when no key specified', async () => {
      // Default is now jinaai/jina-embeddings-v2-base-code
      const worker = await startEmbeddingWorker({
        db,
        enable: true,
        service: createMockEmbeddingService(768),
      });
      
      expect(worker).toBeDefined();
      await worker.stop();
    });

    it('fails gracefully for unknown model', async () => {
      await expect(
        startEmbeddingWorker({
          db,
          modelKey: 'nonexistent-model',
          enable: true,
        })
      ).rejects.toThrow(/not found in database/);
    });
  });

  describe('job processing with model switching', () => {
    it('processes jobs with different model keys in payload', async () => {
      const jq = new JobQueue(db);
      
      // Enqueue job with specific model
      await jq.enqueue({
        queue: 'embeddings',
        jobType: 'embed_chunk',
        payload: {
          chunkId: 'test-chunk-1',
          modelKey: 'transformers::Xenova/all-MiniLM-L6-v2',
          expectedDimension: 384,
        },
      });

      const worker = await startEmbeddingWorker({
        db,
        enable: true,
        service: createMockEmbeddingService(384),
      });

      // Wait for job processing
      await new Promise((r) => setTimeout(r, 500));
      await worker.stop();

      // Verify job completed
      const stats = await jq.getQueueStats('embeddings');
      expect(stats[0]?.succeeded).toBeGreaterThan(0);
    });
  });
});

// Helper to create mock embedding service
function createMockEmbeddingService(dimensions: number) {
  return {
    generateEmbedding: async (text: string) => ({
      embedding: new Array(dimensions).fill(0.1),
      tokenCount: text.length,
    }),
    generateEmbeddings: async (texts: string[]) =>
      texts.map((text) => ({
        embedding: new Array(dimensions).fill(0.1),
        tokenCount: text.length,
      })),
    getConfig: () => ({ modelId: 'mock-model' }),
    dispose: async () => {},
    initialize: async () => {},
  };
}
```

### 5. Error Handling Tests

**File**: `packages/embeddings/src/__tests__/embedding-worker-error-handling.test.ts`

```typescript
describe('Embedding Worker Error Handling', () => {
  it('logs error message and stack when worker fails to start', async () => {
    const loggedErrors: unknown[] = [];
    const mockLogger = {
      error: (...args: unknown[]) => loggedErrors.push(args),
      // ... other methods
    };

    // Trigger an error and verify it's logged with message/stack
    // (implementation depends on how you inject the logger)
  });

  it('handleBatchFailure logs the actual error, not empty object', async () => {
    // Verify that when jobs fail, the error message is captured
  });
});
```

## Testing Tips & Gotchas

### 1. Cache Invalidation
The `getModelConfigFromDb` function caches results. **Always call `clearModelConfigCache()`** between tests:

```typescript
import { clearModelConfigCache } from '../worker/embedding-worker';

beforeEach(() => {
  clearModelConfigCache();
});
```

### 2. Database Migration
Tests need the full migration to run (especially migration 015 which seeds the models table):

```typescript
import { migrate } from '@brainstrike/db';
await migrate(db);
```

### 3. Mock Services for Unit Tests
To avoid loading actual transformers.js models, inject a mock service:

```typescript
const worker = await startEmbeddingWorker({
  db,
  service: mockEmbeddingService, // Bypasses model loading
  enable: true,
});
```

### 4. Provider Type Exhaustiveness
When adding new providers, TypeScript should catch missing cases. Add tests to verify:

```typescript
it('all provider types are handled', () => {
  const providers: EmbeddingProviderType[] = [
    'local', 'transformers', 'openai', 'google', 'cohere', 'voyage'
  ];
  for (const provider of providers) {
    expect(() => isLocalProviderType(provider)).not.toThrow();
    expect(() => isHostedProvider(provider)).not.toThrow();
  }
});
```

### 5. Error Serialization
Error objects don't JSON.stringify properly. Always extract message/stack:

```typescript
// BAD - logs {}
logger.error('Failed:', error);

// GOOD - logs actual error
logger.error('Failed', {
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});
```

### 6. Model Key Formats
The system now uses HuggingFace IDs everywhere. Test these formats:

| Format | Example | Notes |
|--------|---------|-------|
| HuggingFace ID | `jinaai/jina-embeddings-v2-base-code` | Primary format |
| Composite (double colon) | `transformers::Xenova/all-MiniLM-L6-v2` | Provider prefix + HuggingFace ID |
| Composite local | `local::jinaai/jina-embeddings-v2-base-code` | Alternative provider prefix |

> **Deprecated**: Short registry keys like `jina-code` are no longer used. The default model key is now `jinaai/jina-embeddings-v2-base-code`.

## Running the Tests

```bash
# Run all embeddings package tests
pnpm test --filter @brainstrike/embeddings

# Run specific test file
pnpm vitest run packages/embeddings/src/__tests__/model-registry.test.ts

# Run with coverage
pnpm test --filter @brainstrike/embeddings -- --coverage
```

## Success Criteria

1. All new tests pass
2. No regression in existing tests
3. Code coverage for `embedding-worker.ts` model resolution paths ≥80%
4. Tests cover all model key formats (registry keys, HuggingFace IDs, composite keys)
5. Tests verify error messages are properly logged (not empty `{}`)

## Questions?

Reach out if you need clarification on:
- How workerpool spawns Web Workers for transformers.js
- The job queue claim/process lifecycle
- How to mock the embedding service for unit tests

## Future Work

The static model registry (`model-registry.ts`) is deprecated and will be removed in BST-78. See work item BST-72 for the full migration plan. The database is now the single source of truth for model configuration.
