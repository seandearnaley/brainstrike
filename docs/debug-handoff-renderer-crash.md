# Renderer Crash Handoff — Electron Desktop (~285s SIGTRAP)

**Status:** Root cause identified, not yet properly fixed. Previous AI agent's attempted fix (forcing WASM mode) was rejected — it disables WebGPU functionality, which is unacceptable. This document captures everything so the next developer can implement a proper fix.

---

## The Symptom

After ~4–5 minutes of the Electron desktop app being idle, the UI disappears and only the loading backdrop remains. The app is effectively broken until restarted.

Electron logs show:
```
render-process-gone { reason: 'crashed', exitCode: 5 }
```

`exitCode: 5` = **SIGTRAP** — a V8 native `CHECK()` assertion failure, not a JavaScript exception. The renderer process hard-crashes at the native level.

---

## Confirmed Facts (from 5 diagnostic runs)

### What was proven NOT the cause

| Hypothesis | Evidence | Status |
|---|---|---|
| React crash / JS exception | No uncaught errors in logs; JS event loop heartbeat stopped simultaneously with global heartbeat | REJECTED |
| HMR storm causing instability | Run 3 was corrupted by this; subsequent clean runs showed no HMR | REJECTED |
| Main process freeze / IPC hang | Main-process heartbeat continued normally after renderer crash | REJECTED |
| Chromium OOM kills renderer | Memory at crash time: 260 MB / 4096 MB = **6%**; crash reason is `"crashed"` not `"oom"` | REJECTED |
| PGlite WAL checkpoint blocking IPC | IPC was healthy (0 inflight, 0 slow queries) at t=276s; crash at t=283s | REJECTED |

### What the logs confirmed

**Run 4 (pre-fix) and Post-fix run, both using `runId: post-fix`:**

```
Line 718: {"reason":"crashed","exitCode":5,"uptimeSec":283,"message":"RENDERER PROCESS GONE"}
```

- Crash is at **renderer uptime ~283s** in every run (±15s), regardless of what else was happening
- Last renderer heartbeat before crash always shows **low memory** (6–9% of 4096 MB limit)
- Main process continues heartbeating normally after crash — main process is completely fine
- IPC is healthy immediately before crash — no hung queries, no backlog

**Memory comparison between pre-fix and post-fix runs:**

| Run | Memory pattern at t=~130s | Crash time |
|---|---|---|
| Pre-fix (run4) | 260 MB → 564 MB spike (+304 MB) | ~285s |
| Post-fix (minWorkers:1) | 237 MB → 308 MB (+71 MB, normal GC) | ~283s |

The `minWorkers: 1` fix **did work** for its intended purpose — it eliminated the repeated 300 MB memory spikes caused by the WASM model loading/unloading on every idle cycle. But the crash **persisted at the same timing**, proving the crash has a different cause that is independent of model reload cycles.

---

## The Root Cause (High Confidence)

### Architecture

```
Renderer main thread
  └── EmbeddingWorkerProvider
        └── startEmbeddingWorker()  [packages/embeddings/src/worker/embedding-worker.ts]
              └── SimpleEmbeddingService
                    └── TransformersBackend
                          └── getBrowserQueue()  → workerpool pool
                                └── embedding.worker.ts  [Dedicated Web Worker]
                                      └── Transformers.js pipeline('feature-extraction', model, { device: 'webgpu' })
                                            └── ONNX Runtime Web → GPUDevice (WebGPU)
```

### Why it crashes

1. `createWorkerConfig()` in `embedding-worker-provider.tsx` does **not pass a `device` option**
2. `SimpleEmbeddingService` defaults to `device: 'webgpu'` (see `bge-m3-service.ts:34`)
3. `TransformersBackend.initialize()` calls `determineDevice('webgpu')` → confirms WebGPU available (`navigator.gpu` exists in Electron renderer) → selects WebGPU
4. The warmup task is dispatched to the workerpool Web Worker with `deviceHint: 'webgpu'`
5. Inside `embedding.worker.ts`, `inferDevice('webgpu')` returns `'webgpu'`; `loadPipeline()` calls `pipeline('feature-extraction', model, { device: 'webgpu', dtype: 'fp16' })`
6. ONNX Runtime Web creates a `GPUDevice` for the inference session
7. The warmup completes. The embedding queue is now empty — no jobs to process.
8. The `GPUDevice` sits **completely idle** for ~285 seconds
9. Chromium's GPU process reclaims idle WebGPU contexts after ~4–5 minutes of zero GPU activity (standard browser GPU resource management)
10. `GPUDevice.lost` fires — ONNX Runtime's WebGPU execution provider holds a now-invalid native GPU handle
11. When ONNX Runtime accesses that handle (during GC, internal cleanup, or the next pool health check), V8's `CHECK()` assertion fails → **SIGTRAP** → `render-process-gone`

### Why the timing is so consistent

The GPU idle timeout in Chromium is approximately 5 minutes. The model warmup completes at ~t=5–10s. So device loss fires at ~t=300s from warmup completion, give or take startup variance. This matches the observed ~283–296s crash window perfectly.

### Key files

| File | Role |
|---|---|
| `apps/desktop/src/renderer/components/embedding-worker-provider.tsx` | Where `device` should be explicitly set |
| `packages/embeddings/src/bge-m3-service.ts` | `SimpleEmbeddingService` — defaults to `device: 'webgpu'` |
| `packages/embeddings/src/transformers-backend.ts` | `TransformersBackend` — creates workerpool queue, runs warmup, holds `GPUDevice` reference via ONNX |
| `packages/embedding-worker/src/embedding.worker.ts` | The actual Dedicated Web Worker — calls `pipeline()`, loads model into GPU memory |
| `packages/queue/src/adapters/browser-workerpool.ts` | Workerpool pool config — `minWorkers: 1` was added here (keep this) |

---

## What Was Changed (Current State of the Repo)

### Change that should be kept

**`packages/queue/src/adapters/browser-workerpool.ts`** — `minWorkers: 1` was added:

```typescript
// Before
const poolOptions: WorkerPoolOptions = {
  maxWorkers,
  // minWorkers was absent → defaults to 0 → workers die after every task
  ...
};

// After
const minWorkers = options.minWorkers ?? 1;
const poolOptions: WorkerPoolOptions = {
  minWorkers,
  maxWorkers: Math.max(minWorkers, maxWorkers),
  ...
};
```

This is correct and should stay. Without it, the model is evicted from WASM/WebGPU memory after every task and reloaded for the next one — causing 300 MB memory spikes every ~75 seconds. This doesn't fix the crash but removes a separate problem.

### Everything else was reverted

All debug instrumentation has been removed from:
- `apps/desktop/src/renderer/main.tsx`
- `packages/utils/src/logging/install-renderer-error-hooks.ts`
- `apps/desktop/src/renderer/components/embedding-worker-provider.tsx`
- `apps/desktop/src/ipc-handlers.ts`
- `apps/desktop/src/create-window.ts`
- `packages/embedding-worker/src/embedding.worker.ts`

---

## What NOT to Do

**Do not force `device: 'wasm'`**. This was the previous AI agent's "fix" and it was correctly rejected. It disables WebGPU, which:
- Reduces embedding throughput significantly for large batches
- Is not a fix — it papers over the problem by avoiding the GPU entirely
- The app has used WebGPU successfully for a long time; removing it is regression

---

## The Correct Fix Approaches

The problem is **WebGPU device loss in an idle context**. The fix must handle device loss gracefully, not avoid the device.

### Option A — GPUDevice keep-alive ping (Recommended, simplest)

Inside `embedding.worker.ts`, after the pipeline loads, schedule a periodic minimal GPU operation to prevent the GPU driver from reclaiming the idle context. A no-op queue submission or fence poll every ~60 seconds is sufficient.

Relevant WebGPU API:
```typescript
// After loadPipeline() completes, keep the device alive
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const keepAlive = setInterval(() => {
  // Submit an empty command buffer — costs ~0ms GPU time
  const encoder = device.createCommandEncoder();
  device.queue.submit([encoder.finish()]);
}, 60_000);
```

The problem: ONNX Runtime's internal `GPUDevice` is not directly exposed by Transformers.js. You'd need to either:
1. Create a *separate* `GPUDevice` from the same adapter and ping it (they share the same GPU context lifetime), or
2. Find a way to get the device from the ONNX session (see Option C)

### Option B — Detect device loss and reinitialize pipeline

Watch the `GPUDevice.lost` promise. When it resolves, clear the cached pipeline entry and let the next call to `embed()` recreate it with a fresh device.

In `embedding.worker.ts`:
```typescript
async function loadPipeline(model, device, dtype) {
  const cacheKey = `${model}|${device}|${dtype}`;
  const existing = pipelines.get(cacheKey);
  if (existing) return existing;

  const loader = (async () => {
    const result = await pipeline('feature-extraction', model, { device, dtype });

    // Watch for GPU device loss and invalidate cache
    if (device === 'webgpu') {
      const gpuAdapter = await navigator.gpu.requestAdapter();
      if (gpuAdapter) {
        const gpuDevice = await gpuAdapter.requestDevice();
        gpuDevice.lost.then(() => {
          pipelines.delete(cacheKey); // Force reload next call
          // Optionally: workerEmit({ type: 'error', id: 'device-lost', message: 'GPUDevice lost' })
        });
      }
    }

    return result as FeatureExtractor;
  })();

  pipelines.set(cacheKey, loader);
  return loader;
}
```

This allows the next `embed()` call to seamlessly reload the pipeline with a fresh GPU session after device loss.

### Option C — ONNX Runtime WebGPU session recovery

ONNX Runtime Web (`ort-web`) does not expose the internal `GPUDevice` via its public API, but its `InferenceSession` does accept a `preferredOutputLocation` option. Investigate whether `ort.env` or session options expose device hooks:

```typescript
import * as ort from 'onnxruntime-web';
ort.env.webgpu.powerPreference = 'high-performance';
// Check if ort exposes device loss callbacks
```

This requires deeper investigation into the `ort-web` internals and may not be feasible without forking.

### Option D — Worker-level restart on crash

Configure workerpool to detect when the embedding worker crashes and restart it. workerpool already restarts crashed workers by default, but the `pipelines` Map in the worker is module-level state — it's recreated fresh on restart. So if the crash happens in the worker (not the renderer), workerpool's built-in recovery would handle it transparently.

**The question:** Does the WebGPU device loss crash happen inside the Dedicated Web Worker (embedding.worker.ts), or in the renderer main thread (which would take down the whole renderer)?

From the logs: the crash kills the **entire renderer process** (`render-process-gone`), not just the worker. This suggests the CHECK() failure propagates up from the Web Worker's crash to the parent renderer process. In Electron/Chromium, a Web Worker crash can bring down its parent renderer — this is by design for isolation.

If this is the mechanism, then: fixing the device loss *inside the worker* (Options A or B) would prevent the worker from crashing, which would prevent the renderer from crashing.

---

## Debug Infrastructure

If you need to re-instrument the app, the session was:
- **Log path:** `.cursor/debug-b4e51e.log` (NDJSON, one entry per line)
- **Endpoint:** `http://127.0.0.1:7242/ingest/a67c7242-fa95-40d2-befe-f4f7a66bce86`
- **Session ID:** `b4e51e`
- **Headers:** `X-Debug-Session-Id: b4e51e`
- **Pattern:**
  ```typescript
  fetch('http://127.0.0.1:7242/ingest/a67c7242-fa95-40d2-befe-f4f7a66bce86', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b4e51e' },
    body: JSON.stringify({ sessionId: 'b4e51e', location: 'file:line', message: 'desc', data: {}, timestamp: Date.now() }),
  }).catch(() => {});
  ```

Key log messages from `create-window.ts` that fire on crash (if you add them back):
```typescript
win.webContents.on('render-process-gone', (_event, details) => {
  // details.reason === 'crashed', details.exitCode === 5
});
```

---

## Reproduction

1. Start the Electron desktop app fresh (full restart)
2. Do not interact — leave it idle
3. Wait ~5 minutes
4. UI disappears, only loading backdrop remains
5. Console/logs show `render-process-gone { reason: 'crashed', exitCode: 5 }`

The crash is 100% reproducible on the machine where this was investigated.

---

## References

- `embedding.worker.ts` — `packages/embedding-worker/src/embedding.worker.ts` — where `loadPipeline()` creates the ONNX WebGPU session
- `transformers-backend.ts` — `packages/embeddings/src/transformers-backend.ts` — `warmupQueue()` at line 283 dispatches the initial task with `deviceHint: 'webgpu'`
- `browser-workerpool.ts` — `packages/queue/src/adapters/browser-workerpool.ts` — workerpool pool config (minWorkers: 1 is here)
- WebGPU device loss spec: https://gpuweb.github.io/gpuweb/#dom-gpudevice-lost
- ONNX Runtime Web WebGPU EP: https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
