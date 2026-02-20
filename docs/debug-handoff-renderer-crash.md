# Renderer Crash — Electron Desktop (~285s SIGTRAP)

**Status:** RESOLVED (2026-02-19). Three-layer fix deployed and confirmed working (10+ minutes idle, zero crashes).

---

## The Symptom (Original)

After ~4-5 minutes of the Electron desktop app being idle, the UI disappears and only the loading backdrop remains. The app is effectively broken until restarted.

Electron logs show:
```
render-process-gone { reason: 'crashed', exitCode: 5 }
```

`exitCode: 5` = **SIGTRAP** — a V8 native `CHECK()` assertion failure, not a JavaScript exception. The renderer process hard-crashes at the native level.

---

## Root Cause Analysis

### Architecture

```
Renderer main thread
  └── EmbeddingWorkerProvider
        └── startEmbeddingWorker()
              └── SimpleEmbeddingService
                    └── TransformersBackend
                          └── getBrowserQueue()  → workerpool pool
                                └── embedding.worker.ts  [Dedicated Web Worker]
                                      └── Transformers.js pipeline('feature-extraction', model, { device: 'webgpu' })
                                            └── ONNX Runtime Web → GPUDevice (WebGPU)
```

### What caused the crash

1. ONNX Runtime Web creates a `GPUDevice` internally for WebGPU inference
2. After warmup completes, the embedding queue is empty — no GPU activity
3. The `GPUDevice` sits completely idle
4. **Chromium's renderer backgrounding** freezes the renderer process after ~5 minutes of inactivity, stopping all JS timers (including any keep-alive mechanisms)
5. During the freeze/unfreeze transition, Dawn's WebGPU backend encounters stale GPU state
6. ONNX Runtime accesses the now-invalid native GPU handle → V8 `CHECK()` assertion failure → **SIGTRAP** → `render-process-gone`

### Key finding: NO idle timer in Dawn or Metal

Research into Dawn (Chromium's WebGPU implementation) and macOS Metal confirmed there is **no idle device reclamation timer** at the GPU driver level. The device is not being reclaimed due to inactivity — rather, **Chromium's renderer process management** (background throttling → tab freezing) is the trigger. This is why a simple GPU keep-alive without `backgroundThrottling: false` failed in the first fix attempt.

### Why the timing is consistent (~285s)

Chromium's background tab lifecycle:
- **0-5s unfocused**: No throttling
- **After 5s**: Timers throttled to minimum 1s intervals
- **After ~5 minutes (300s)**: Renderer may be **frozen** (all JS execution stops)

The model warmup completes at ~t=5-10s. The crash occurs at ~t=283-296s from startup, matching the ~300s freeze threshold minus startup time.

---

## The Fix (Three Layers)

### Layer 1: Prevent renderer backgrounding (ROOT CAUSE FIX)

**File:** `apps/desktop/src/create-window.ts`

Added `backgroundThrottling: false` to `BrowserWindow` webPreferences:

```typescript
webPreferences: {
  // ... existing options ...
  // Prevent Chromium from throttling timers and deprioritising this renderer
  // when the window is unfocused or minimised. The embedding worker's WebGPU
  // keep-alive interval must fire reliably to prevent GPU device idle reclamation.
  backgroundThrottling: false,
},
```

This prevents Chromium from throttling or freezing the renderer process when the window is unfocused. Without this, the keep-alive timer in the Web Worker stops firing, leaving the GPU device unattended.

### Layer 2: GPU keep-alive and device loss guard

**File:** `packages/embedding-worker/src/embedding.worker.ts`

After the WebGPU pipeline loads, the worker now:

1. **Obtains the ONNX Runtime internal GPUDevice** via `env.backends.onnx.webgpu.device` (a `Promise<GPUDevice>` frozen by ONNX Runtime after first inference)
2. **Starts a keep-alive timer** (every 15s) that submits a real command buffer (`createCommandEncoder().finish()`) to register GPU activity with the driver
3. **Watches `GPUDevice.lost`** — if the device is lost, emits an error event, invalidates cached pipelines, and terminates the worker via `self.close()` so workerpool spawns a fresh replacement

Key functions:
- `getOrtWebGpuDevice()` — Accesses ONNX Runtime's internal GPUDevice
- `startKeepAlive(device)` — Periodic real command buffer submission
- `watchDeviceLoss(device)` — Listens to `GPUDevice.lost` promise
- `initWebGpuDeviceGuard()` — Orchestrator called after pipeline loads

Why real command buffers, not empty `queue.submit([])`:
- `queue.submit([])` is a no-op at the driver level (no work sent to GPU)
- `createCommandEncoder().finish()` creates a real (empty) command buffer that flows through Dawn's full encoding and submission pipeline, registering as genuine GPU activity

### Layer 3: Crash recovery handler

**File:** `apps/desktop/src/create-window.ts`

Added `render-process-gone` event handler that:
1. Logs crash details (reason, exit code, elapsed time)
2. Automatically reloads the renderer for `'crashed'` and `'abnormal-exit'` reasons

```typescript
win.webContents.on(
  'render-process-gone',
  (_event, details) => {
    startupLogger.error('Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      elapsedMs: Date.now() - startupStartedAt,
    });
    if (details.reason === 'crashed' || details.reason === 'abnormal-exit') {
      startupLogger.info('Attempting renderer recovery via reload');
      try {
        win.webContents.reload();
      } catch (reloadError) {
        startupLogger.error('Renderer reload failed after crash', { reloadError });
      }
    }
  }
);
```

### Existing fix (kept)

**File:** `packages/queue/src/adapters/browser-workerpool.ts`

`minWorkers: 1` — Prevents the WASM model from being evicted and reloaded on every task cycle (eliminated 300 MB memory spikes). Also ensures workerpool auto-spawns a replacement worker if one crashes.

---

## Confirmed Working

Log evidence from `localhost-1771561050769.log` shows the fix working:

```
[EmbeddingWorker] Loading pipeline: Xenova/all-MiniLM-L6-v2 webgpu
[EmbeddingWorker] GPU guard: device acquired, starting keep-alive + loss watcher
[EmbeddingWorker] GPU keep-alive started (interval=15000ms)
[EmbeddingWorker] GPU keep-alive tick #1      (~15s)
[EmbeddingWorker] GPU keep-alive tick #9      (~2m 15s)
[EmbeddingWorker] GPU keep-alive tick #17     (~4m 15s)   ← approaching old crash point
[EmbeddingWorker] GPU keep-alive tick #25     (~6m 15s)   ← PAST the ~285s crash point
[EmbeddingWorker] GPU keep-alive tick #33     (~8m 15s)
[EmbeddingWorker] GPU keep-alive tick #41     (~10m 15s)
worker_metrics { uptimeMs: 629997 }                       ← 10.5 minutes, no crash
```

- Zero device loss warnings
- Zero SIGTRAP crashes
- Semantic search executed successfully mid-session
- Keep-alive timer fired reliably every 15 seconds throughout

---

## What Was Tried and Failed

### Attempt 1: GPU keep-alive with `device.queue.submit([])` (FAILED)

Submitted an empty array to the GPU queue every 30 seconds. The crash still occurred at ~285 seconds.

**Why it failed:** Two compounding issues:
1. `backgroundThrottling` was not disabled — Chromium froze the renderer at ~5 minutes, stopping the keep-alive timer entirely
2. `device.queue.submit([])` sends zero work to the GPU — it's a no-op at the driver level

### Previous attempt: Force `device: 'wasm'` (REJECTED)

Disabled WebGPU entirely by forcing WASM execution. Correctly rejected — it papers over the problem and regresses embedding throughput.

---

## Key Technical Details

### ONNX Runtime WebGPU device access path

```
env.backends.onnx.webgpu.device  →  Promise<GPUDevice>
```

- Transformers.js exposes the ONNX Runtime env at `env.backends.onnx`
- ONNX Runtime freezes `env.webgpu.device` via `Object.defineProperty({ writable: false, configurable: false })` after first inference session
- Device cannot be replaced in the same worker — recovery requires worker restart

### ONNX Runtime `preserveDevice` option

PR [#24115](https://github.com/microsoft/onnxruntime/pull/24115) (merged March 2025) added a `preserveDevice` option. By default (OFF), ONNX Runtime destroys the WebGPU device when no inference sessions use it. However, since our pipeline caches the session, this is not the direct trigger for our crash. The option is also not yet exposed in the public API of `onnxruntime-web@1.22.0-dev.20250409`.

### Known related issues

- [transformers.js #943](https://github.com/huggingface/transformers.js/issues/943) — "A valid external Instance reference no longer exists" after Chromium upgrade
- [transformers.js #860](https://github.com/huggingface/transformers.js/issues/860) — Memory leak in WebGPU → eventual device loss
- [ONNX Runtime #26107](https://github.com/microsoft/onnxruntime/issues/26107) — Custom WebGPU device not used at runtime

### Versions

- Electron: 39.2.7
- @huggingface/transformers: 3.8.1
- onnxruntime-web: 1.22.0-dev.20250409
- workerpool: 10.0.1
- macOS: Darwin 25.3.0

---

## Files Modified

| File | Change |
|------|--------|
| `apps/desktop/src/create-window.ts` | Added `backgroundThrottling: false`, `render-process-gone` handler |
| `packages/embedding-worker/src/embedding.worker.ts` | Added WebGPU keep-alive, device loss watcher, worker self-termination |
| `packages/queue/src/adapters/browser-workerpool.ts` | `minWorkers: 1` (from earlier fix, kept) |

---

## References

- WebGPU device loss spec: https://gpuweb.github.io/gpuweb/#dom-gpudevice-lost
- WebGPU device loss best practices: https://toji.dev/webgpu-best-practices/device-loss.html
- ONNX Runtime WebGPU EP: https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- ONNX Runtime WebGPU flags API: https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html
- Chromium background throttling: https://developer.chrome.com/blog/background-tabs/
- Electron BrowserWindow backgroundThrottling: https://www.electronjs.org/docs/latest/api/browser-window
