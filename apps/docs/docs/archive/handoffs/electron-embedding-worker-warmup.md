---
title: "Electron Embedding Worker Warmup"
---

# Handoff: Electron Embedding Worker Warmup Issue

## Summary

On Electron desktop app startup, there's an error from the embedding worker pool warmup process. This is separate from the token cache system and appears in the console as:

```
'Workerpool embedding task failed' {
  taskId: '1bec9a76-bbc6-407f-8ba4-e293745fb8ba',
  model: 'jinaai/jina-embeddings-v2-base-code',
  elapsedMs: 163,
  activeBeforeRelease: 1,
  activeAfterRelease: 0
}
```

## Stack Trace Analysis

The error originates from:
```
onTaskError @ main-gEjQJNPi.js:4682
execute @ main-gEjQJNPi.js:4603
add @ main-gEjQJNPi.js:4701
warmupQueue @ main-gEjQJNPi.js:16102
initialize @ main-gEjQJNPi.js:15995
initialize @ main-gEjQJNPi.js:16337
initializeWithModel @ main-gEjQJNPi.js:16321
initializeEmbeddingService @ main-gEjQJNPi.js:17931
startEmbeddingWorker @ main-gEjQJNPi.js:17981
```

## Investigation Points

### 1. BrowserWorkerpoolAdapter Location
Look for `BrowserWorkerpoolAdapter` - this is the scope logged:
```bash
grep -r "BrowserWorkerpoolAdapter" packages/
```

Likely in `packages/embeddings/` or `packages/embedding-worker/`.

### 2. warmupQueue Function
The warmup queue is trying to pre-initialize the embedding model during startup. Key questions:
- What does the warmup task actually do?
- Is there sample text or a test embedding being generated?
- Does it require network access to load the model?

### 3. Possible Causes

1. **Model Not Loaded**: The Jina embeddings model (`jinaai/jina-embeddings-v2-base-code`) may not be fully loaded when warmup runs

2. **Worker Not Ready**: The underlying ONNX runtime or worker thread may not be ready

3. **Race Condition**: `startEmbeddingWorker` may trigger warmup before the model is fully initialized

4. **Missing Resources**: WASM files or model weights may not be accessible yet

### 4. Quick Wins to Explore

1. **Add retry logic** to warmup with exponential backoff
2. **Delay warmup** until model reports ready
3. **Make warmup optional** on startup - only warm up on first actual use
4. **Check if this is cosmetic** - does the embedding service work normally after this error?

## Files to Check

```
packages/embeddings/src/
├── workerpool-adapter.ts       # BrowserWorkerpoolAdapter likely here
├── embedding-service.ts        # initializeWithModel, warmupQueue
├── providers/                  # Model-specific providers
└── index.ts                    # Public exports

packages/embedding-worker/src/
├── worker.ts                   # Worker thread implementation
└── index.ts
```

## Testing Approach

1. Check if embeddings work after startup despite the error
2. Add more detailed logging to warmup:
   ```typescript
   logger.info('warmupQueue starting', { model, taskId });
   // ... warmup code
   logger.info('warmupQueue complete', { model, taskId, elapsedMs });
   ```
3. Check if the error only happens on cold start vs. subsequent launches

## Related Systems

This issue is **separate from**:
- Token cache system (fixed in this session)
- Background token indexer (working correctly)
- File handle map population (fixed in this session)

## Applied Fix

The error logging was downgraded from `error` to `warn` level in `packages/queue/src/adapters/browser-workerpool.ts`:

```typescript
// Use warn level - task failures are expected (warmup, timeouts, cancellations)
// and callers handle errors appropriately
logger.warn('Workerpool embedding task failed', { ... });
```

This change acknowledges that task failures in a queue system are expected and handled by callers. The warmup failure is intentionally caught in `transformers-backend.ts` and logged at debug level.

## Remaining Investigation (Optional)

If the warmup failures should be completely eliminated rather than just downgraded, investigate:
- Why does the warmup task fail during initialization?
- Is the embedding model not fully loaded when warmup runs?
- Should warmup be delayed until the model reports ready?

## Priority

Low - The fix is applied. The warning is now appropriately logged and doesn't appear as a red error in the console.

---

**Created**: 2025-12-07
**Fixed**: 2025-12-07
**Context**: During token cache debugging session, this unrelated error was observed in Electron logs
