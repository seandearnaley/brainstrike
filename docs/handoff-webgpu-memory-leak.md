# Handoff: WebGPU Memory Leak During Embedding Backfill

## Status: UNRESOLVED — GPU buffer memory grows unboundedly during backfill

**PR**: https://github.com/seandearnaley/brainstrike/pull/786
**Branch**: `fix/renderer-crash-backfill-regression`
**Date**: 2026-03-19

---

## The Problem

When running a large embedding backfill (10K-30K chunks) on a 32GB M2 Pro, the Electron Helper (Renderer) process for the embedding host grows to **2.73 GB** (observed for ~1480 embeddings out of 12,439). The app becomes unusable and eventually crashes or the backfill fails.

**User observation**: Activity Monitor shows the embedding host renderer process growing by ~1GB per 2000 embeddings. No sawtooth, no plateau — monotonic unbounded growth.

**Model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions, local, WebGPU device)

---

## Root Cause (CONFIRMED)

WebGPU GPU buffers allocated by ONNX Runtime via Dawn/Metal **cannot be freed from JavaScript**. This has been confirmed through:

1. **`tensor.dispose()`** — Does NOT free GPU buffers. Only frees JS-side ArrayBuffer. Tested: 21.2 KB/item growth unchanged.
2. **`pipeline.dispose()` / session release** — Does NOT clear ONNX Runtime's internal GPU buffer cache. The cache holds buffers by size for reuse. PR microsoft/onnxruntime#22490 only clears cache when ALL sessions are released, but creating a new session allocates fresh buffers. Tested: 33 KB/item growth (WORSE due to reload overhead).
3. **`destroyAndRestart()` the embedding host BrowserWindow** — Kills the renderer process. Renderer-side memory IS released (sawtooth pattern confirmed in E2E: 695→728→648 MB). BUT the Chromium shared GPU process retains the Metal/Dawn allocations from the destroyed renderer. GPU process still grows at ~11-32 KB/item.
4. **Chromium GPU process limitation** — The GPU process pools all Metal buffer allocations and NEVER returns them to the OS during the app's lifetime. Only closing the entire Electron app frees GPU process memory.

### Evidence from research:
- ONNX Runtime Issue #21574: "GPU memory remains in use after `session.release()`"
- ONNX Runtime Issue #25996: "How to release GPU memory without unloading the model?"
- Transformers.js Issue #860: "Memory leak issue under WebGPU Whisper transcribe pipeline"
- ONNX Runtime docs: "Call `tensor.dispose()` explicitly to destroy the underlying GPU buffer" — BUT this only works for user-created tensors, not internal ONNX Runtime cache buffers
- Key quote: "The garbage collector that quietly cleans up dereferenced objects on the JS side has no jurisdiction over GPUBuffer and GPUTexture allocations"

### IMPORTANT: What has NOT been tried yet
- **`GPUDevice.destroy()`** — Explicitly destroying the WebGPU device should release ALL GPU buffers associated with it. The ONNX Runtime WebGPU backend stores the device at `env.backends.onnx.webgpu.device`. Destroying this device and creating a fresh one might be the correct approach. This was NOT tested in this session.
- **`GPUBuffer.destroy()`** on individual buffers — If ONNX Runtime exposes the buffer objects, explicit destruction might work. Not investigated.
- **ONNX Runtime `env.webgpu.profiling.free` or similar** — There may be internal ONNX Runtime APIs for WebGPU memory management not found in basic docs search.
- **Chromium `--enable-features=WebGPUDeveloperFeatures`** — May expose additional GPU memory debugging capabilities.
- **Using ONNX Runtime's IO binding** — Pre-allocating and reusing GPU buffers instead of letting ONNX Runtime manage them internally.

---

## What HAS Been Fixed (all in PR #786)

These fixes address the original renderer CRASH during backfill. The crash is fixed. The memory growth is not.

### Fix 1: PGlite Live Query Firehose → OOM (CRASH 1)
**Files**: `apps/desktop/src/ipc-handlers.ts`, `packages/vector-management/src/vector-status/use-vector-queue-state.ts`

- **Problem**: 7+ concurrent PGlite live queries fired on every `job_queue` mutation (~90K mutations for 30K backfill). Each result was IPC-serialized to the renderer, causing OOM.
- **Fix**:
  - Reference-counted `acquireLiveSubscriptionPause()`/`releaseLiveSubscriptionPause()` — pauses PGlite subscriptions during backfill
  - Always-on IPC dedup+batch: 200ms foreground / 2s background intervals
  - Added `isJobQueueActive` to `liveQueryEnabled` guard to close React async render race window
- **E2E test**: Tests 1-5 pass. Visible-ui heap flat at 98-117 MB during 20K backfill.

### Fix 2: Unprotected WebGPU Session in Visible-UI (CRASH 2)
**Files**: `apps/desktop/src/create-window.ts`, `apps/desktop/src/main.ts`

- **Problem**: Visible-UI renderer creates its own WebGPU/ONNX session for search. Had NO `backgroundThrottling: false`, NO GPU keep-alive, NO device loss watcher. All protections were only on the embedding host.
- **Fix**:
  - Added `backgroundThrottling: false` to visible-UI BrowserWindow
  - `lock-screen`/`unlock-screen` events now broadcast `suspend`/`resume` power state (previously only logged)

### Fix 3: Backfill Progress Reconciliation After Crash
**Files**: `apps/desktop/src/ipc-handlers.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/embedding-host-shared.ts`, `packages/vector-management/src/vector-status/embedding-runtime-controller.ts`, `packages/vector-management/src/vector-status/use-vector-queue-state.ts`

- **Problem**: After renderer crash, new renderer had no knowledge of in-flight backfill. Progress indicator disappeared.
- **Fix**: Added `getBackfillsInFlight` IPC endpoint. On mount, renderer checks for active backfills and re-attaches to progress stream.

### Fix 4: PGlite VACUUM During Backfill
**File**: `apps/desktop/src/embedding-backfill.ts`

- PGlite (WASM PostgreSQL) has no autovacuum. Embedding UPDATEs create MVCC dead tuples.
- Added periodic VACUUM every 30s during drain phase + final VACUUM after completion.

### Fix 5: Periodic Embedding Host Restart (PARTIALLY EFFECTIVE)
**Files**: `apps/desktop/src/ipc-handlers.ts`, `apps/desktop/src/embedding-host-manager.ts`

- Timer checks succeeded count every 15s. When 500+ items done, calls `stop()` then `destroyAndRestart()`.
- **CRITICAL BUG FOUND**: The original `destroyAndRestart()` killed running jobs, causing "60 job(s) failed" error and aborting the backfill. Fixed by calling `stop()` first for graceful drain. BUT this means the GPU buffers accumulate during each 500-item cycle because `stop()` doesn't kill the process.
- **Current state**: Timer fires but effectiveness is limited. The `assertCanContinue` check is gated by `gpuMemoryReclaimInProgress` flag to prevent backfill abort during restart.

---

## Architecture (Key Files)

### Embedding Host (Hidden Renderer)
- **`apps/desktop/src/embedding-host-manager.ts`** — Manages the hidden BrowserWindow lifecycle. Has `ensureStarted()`, `stop()`, `reset()`, `destroyAndRestart()`.
- **`apps/desktop/src/renderer-host-lifecycle.ts`** — Creates hidden BrowserWindow with `backgroundThrottling: false`, `show: false`.
- **`apps/desktop/src/renderer/components/embedding-host-runtime.tsx`** — Renderer-side component that starts the embedding worker. Line 196: `device: hydratedDevicePref` — this is where WebGPU vs WASM is chosen for the embedding host.

### Embedding Worker (Web Worker inside Embedding Host)
- **`packages/embedding-worker/src/embedding.worker.ts`** — The actual ONNX inference happens here inside a Web Worker. Line 596: `runtime.pipeline('feature-extraction', model, { device, dtype })` creates the ONNX session. Lines 862-873: `embedStream` function processes batches.
- **`packages/embeddings/src/transformers-backend.ts`** — TransformersBackend wraps the Web Worker. `_streamingClient` communicates with the worker. `generateEmbeddingsStream` is the method used during backfill.
- **`packages/embeddings/src/bge-m3-service.ts`** — SimpleEmbeddingService wraps TransformersBackend.

### Backfill Flow
1. User clicks "Backfill" → `use-vector-queue-state.ts` → `controller.enqueueBackfill()`
2. → `embedding-runtime-controller.ts` → `desktopHost.enqueueBackfill()`
3. → IPC → `ipc-handlers.ts` EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL handler
4. → `embedding-backfill.ts` `enqueueEmbeddingBackfill()` — enqueues jobs into `job_queue`
5. → Embedding host Web Worker claims jobs, runs ONNX inference, writes embeddings back to DB
6. → `waitForEmbeddingSetDrain()` waits for all jobs to complete

### Database
- **`apps/desktop/src/db-main.ts`** — PGlite (PostgreSQL in WASM) runs in main process
- Embeddings stored via `UPDATE file_chunks SET embedding = ...` (creates MVCC dead tuples)
- HNSW indexes on embedding columns (migration 014)

---

## Test Infrastructure

### Playwright E2E Tests (apps/desktop/e2e/)
- Tests 1-6 in `embedding-worker-renderer.test.ts`
- Run with: `pnpm --filter @brainstrike/desktop exec playwright test --grep "crash repro"`
- GPU disabled by default (`--disable-gpu`). Enable with `BRAINSTRIKE_E2E_ALLOW_GPU=1`
- Use `BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1` for production backgrounding behavior
- Tests use `getRendererTimeOrigin()` to detect crashes (performance.timeOrigin changes on reload)
- Tests use `extractUnexpectedLifecycleLogs()` to detect crash recovery events

### Vitest 4 Browser Mode Tests (packages/embedding-worker/test/)
- `webgpu-memory-growth.browser.test.ts` — Runs in REAL Chromium with WebGPU
- Run with: `pnpm --filter @brainstrike/embedding-worker vitest run --project browser`
- Uses `cdp()` from `vitest/browser` for Chrome DevTools Protocol access
- `headless: false` in vitest.config.mts so WebGPU has real GPU access
- CDP `Performance.getMetrics` gives JS heap only (not GPU buffers)
- CDP `SystemInfo.getProcessInfo` requires browser-level target (not available from page)

---

## Next Steps (Priority Order)

### 1. Investigate `GPUDevice.destroy()` (HIGH PRIORITY)
The ONNX Runtime WebGPU backend stores the GPUDevice at `env.backends.onnx.webgpu.device` (it's a Promise). Destroying this device should release ALL associated GPU buffers. The question is whether ONNX Runtime can recover from a destroyed device by creating a new one.

**Try in the Vitest browser test**:
```typescript
import * as ort from 'onnxruntime-web';
// After N inferences:
const device = await ort.env.webgpu.device;
device.destroy();
// Then reinitialize the pipeline
```

**Key risk**: ONNX Runtime freezes `env.webgpu.device` with `configurable: false` after first use. A fresh device may only be obtainable by creating a new Worker (which the embedding host's workerpool already supports via `minWorkers: 1` auto-respawn).

### 2. Consider WASM Fallback for Backfill (MEDIUM PRIORITY)
If GPUDevice.destroy() doesn't work, the pragmatic fix is WASM for batch backfill. The change is one line in `embedding-host-runtime.tsx:196`:
```typescript
device: 'wasm', // instead of hydratedDevicePref
```
**Trade-off**: ~1.75x slower (67 min vs 38 min for 30K chunks). But memory stays flat (confirmed 0 MB growth in E2E test).

### 3. Make Vitest Browser Test Measure Real Memory (MEDIUM)
The current test measures JS heap (flat) but not GPU memory (growing). Options:
- Use `navigator.gpu.requestAdapter()` then `adapter.requestAdapterInfo()` to check GPU limits
- Use Vitest `commands` API to call Node.js `process.memoryUsage()` from server side
- Use `crossOriginIsolated` + `performance.measureUserAgentSpecificMemory()` for broader measurements
- Simply run the test with `headless: false` and observe Activity Monitor

### 4. Revert destroyAndRestart If It Causes Issues (LOW)
The timer-based `destroyAndRestart` in `ipc-handlers.ts` caused "60 jobs failed" errors in production. The `stop()` before `destroyAndRestart()` fix may help but hasn't been confirmed on the user's machine. If it still causes issues, remove the timer entirely — it's not solving the GPU memory problem anyway.

---

## Key Decisions Made

1. **TDD approach**: All fixes were developed test-first. Tests written to fail, then fixes applied to make them pass.
2. **5-agent parallel investigation**: Used Log Analyst, Memory Forensics, Devil's Advocate, E2E Test Architect, and Code Path Tracer agents in parallel for the initial root cause analysis.
3. **Reference-counted pause/resume**: `acquireLiveSubscriptionPause`/`releaseLiveSubscriptionPause` with depth counter prevents `setBackgrounded(false)` from resuming queries mid-backfill.
4. **IPC always-batched**: Changed from "batch only when backgrounded" to "always batch with 200ms foreground / 2s background intervals". Prevents IPC flooding regardless of renderer-side guards.
5. **backgroundThrottling on visible-UI**: Added to prevent GPU device invalidation in the search embedder. Has power/battery trade-off but acceptable for desktop app.

---

## User Feedback & Pain Points

- The user is **extremely frustrated** by the number of iterations without a working fix for the memory growth.
- They specifically asked for **TDD with failing tests first** before any fix attempts.
- They called out that previous fixes were pushed without being confirmed by E2E tests.
- The `destroyAndRestart` approach caused **data loss** (60 failed jobs, 0/12439 embedded, PG ERR shown in UI).
- The user values **WebGPU performance** and rejected WASM fallback because "the backfill is the thing that is too slow."

---

## Files Modified in PR #786

```
apps/desktop/e2e/embedding-worker-renderer.test.ts  — 7 crash repro regression tests
apps/desktop/e2e/utils/electron-helpers.mts          — ALLOW_BACKGROUNDING + ALLOW_GPU env vars
apps/desktop/src/create-window.ts                    — backgroundThrottling: false on visible-ui
apps/desktop/src/embedding-backfill.ts               — VACUUM + onDrainTick callback
apps/desktop/src/embedding-host-manager.ts           — destroyAndRestart() method
apps/desktop/src/embedding-host-shared.ts            — getBackfillsInFlight channel
apps/desktop/src/ipc-handlers.ts                     — IPC throttling, live query pausing, GPU reclaim timer, backfill reconciliation
apps/desktop/src/main.ts                             — lock-screen/unlock-screen power state
apps/desktop/src/preload.ts                          — getBackfillsInFlight bridge
apps/desktop/src/__tests__/create-window.test.ts     — backgroundThrottling in expected config
apps/desktop/src/__tests__/main/ipc-handlers-db.test.ts — flushPendingLiveUpdates in assertions
packages/embedding-worker/src/embedding.worker.ts    — tensor.dispose() on output
packages/embedding-worker/test/webgpu-memory-growth.browser.test.ts — Vitest browser test
packages/embedding-worker/vitest.config.mts          — browser project config
packages/embeddings/src/worker/embedding-worker.ts   — inline reinitialize (not effective for WebGPU)
packages/vector-management/src/vector-status/embedding-runtime-controller.ts — getBackfillsInFlight
packages/vector-management/src/vector-status/use-vector-queue-state.ts — isJobQueueActive guard + reconciliation
packages/vector-management/src/__tests__/*.test.ts   — mock updates for new interface
packages/preferences/src/stores/vector-status-ui-store.ts — (linter reformatted)
```
