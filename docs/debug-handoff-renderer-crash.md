# Renderer Crash & Idle Freeze — Electron Desktop

**Status:** RESOLVED (2026-02-28). Two issues identified and fixed:
1. **SIGTRAP crash** (~285s idle) — GPU device invalidated by Chromium renderer backgrounding
2. **Beach ball freeze** (extended idle/sleep) — Main thread blocked by sync I/O flood, GPU stalls on wake, and naive crash recovery

---

## Issue 1: SIGTRAP Crash (~285s idle)

**Original status:** RESOLVED (2026-02-19). Three-layer fix deployed and confirmed working (10+ minutes idle, zero crashes).

### The Symptom

After ~4-5 minutes of the Electron desktop app being idle, the UI disappears and only the loading backdrop remains. The app is effectively broken until restarted.

Electron logs show:
```
render-process-gone { reason: 'crashed', exitCode: 5 }
```

`exitCode: 5` = **SIGTRAP** — a V8 native `CHECK()` assertion failure, not a JavaScript exception. The renderer process hard-crashes at the native level.

### Root Cause

```
Hidden host renderer main thread
  └── EmbeddingHostRuntime
        └── startEmbeddingWorker()
              └── SimpleEmbeddingService
                    └── TransformersBackend
                          └── getBrowserQueue()  → workerpool pool
                                └── embedding.worker.ts  [Dedicated Web Worker]
                                      └── Transformers.js pipeline('feature-extraction', model, { device: 'webgpu' })
                                            └── ONNX Runtime Web → GPUDevice (WebGPU)
```

1. ONNX Runtime Web creates a `GPUDevice` internally for WebGPU inference
2. After warmup completes, the embedding queue is empty — no GPU activity
3. The `GPUDevice` sits completely idle
4. **Chromium's renderer backgrounding** freezes the renderer process after ~5 minutes of inactivity, stopping all JS timers (including any keep-alive mechanisms)
5. During the freeze/unfreeze transition, Dawn's WebGPU backend encounters stale GPU state
6. ONNX Runtime accesses the now-invalid native GPU handle → V8 `CHECK()` assertion failure → **SIGTRAP** → `render-process-gone`

### Key finding: NO idle timer in Dawn or Metal

Research into Dawn (Chromium's WebGPU implementation) and macOS Metal confirmed there is **no idle device reclamation timer** at the GPU driver level. The device is not being reclaimed due to inactivity — rather, **Chromium's renderer process management** (background throttling → tab freezing) is the trigger.

### The Fix (Three Layers)

#### Layer 1: Isolate renderer backgrounding to the hidden host (ROOT CAUSE FIX)

**Files:** `apps/desktop/src/create-window.ts`, `apps/desktop/src/embedding-host-manager.ts`

The visible BrowserWindow now keeps Chromium defaults. The hidden embedding host BrowserWindow sets `backgroundThrottling: false`, so only the renderer that owns WebGPU/WASM inference stays unthrottled when unfocused.

#### Layer 2: GPU keep-alive and device loss guard

**File:** `packages/embedding-worker/src/embedding.worker.ts`

After the WebGPU pipeline loads, the worker:
1. **Obtains the ONNX Runtime internal GPUDevice** via `env.backends.onnx.webgpu.device`
2. **Starts a keep-alive timer** (every 15s) that submits a real command buffer to register GPU activity
3. **Watches `GPUDevice.lost`** — emits error event, invalidates cached pipelines, terminates worker

#### Layer 3: Crash recovery handler

**File:** `apps/desktop/src/create-window.ts`

Handles `render-process-gone` with deferred recovery (see Issue 2 fix for details on why deferred, not immediate).

---

## Issue 2: Beach Ball Freeze (Extended Idle / Sleep-Wake)

**Status:** RESOLVED (2026-02-28). Six-fix package addressing main thread blocking during idle and sleep/wake transitions.

### The Symptom

After leaving the desktop app idle for an extended period (Mac sleep, screen lock, or unfocused for hours), the app freezes with a macOS beach ball. The renderer process is unresponsive — either blocked on long synchronous work or unable to paint frames.

### Root Cause Analysis

Six contributing factors identified:

1. **Naive crash recovery** — The original `render-process-gone` handler called `win.webContents.reload()` synchronously. Reloading while backgrounded (especially during a POSIX signal storm) could permanently freeze the main thread.

2. **No `powerMonitor` handling** — Zero suspend/resume awareness. When Mac sleeps and wakes, file system events queue in the OS and flood in on wake.

3. **GPU rasterization flags** — `enable-gpu-rasterization` and `enable-zero-copy` caused GPU process stalls when hardware resets after Mac sleep.

4. **File watcher sync I/O** — `startFsWatch()` used `fs.existsSync()` + `fs.statSync()` in callbacks. Queued events arriving in bursts after sleep each triggered blocking I/O.

5. **GPU keep-alive during suspend** — The keep-alive timer submitted GPU commands on a potentially invalid device after system wake.

6. **Live query IPC during idle** — PGlite live query listeners fired IPC updates to the renderer even when backgrounded, adding unnecessary event loop work.

---

## The Fixes

### Fix 1: Deferred Crash Recovery

**File:** `apps/desktop/src/create-window.ts`

Replaced synchronous `win.webContents.reload()` with a deferred recovery strategy:

- **Crash loop detection:** Tracks crash count within a 30-second window. After 3 crashes, stops attempting recovery.
- **Deferred reload:** Instead of reloading immediately (which blocks main thread), sets a `recoveryPending` flag.
- **Reload triggers:** Recovery happens when the window receives `focus` (user clicks) or the app receives `activate` (macOS dock click). This ensures the reload happens when the user is actively engaged.
- **Fallback timer:** 3-second `setTimeout` handles the edge case where the window is already focused when the crash occurs.
- **isDestroyed guard:** Prevents reload on a destroyed window.

### Fix 2: GPU Flag Management

**Files:** `apps/desktop/src/gpu-flags.ts`, `apps/desktop/src/main.ts`

**Removed flags:**
- `enable-gpu-rasterization` — Causes GPU process stalls when hardware resets after Mac sleep
- `enable-zero-copy` — Same issue, compounds with gpu-rasterization

**Added flags via `--disable-features`:**
- `MacWebContentsOcclusion` — Prevents macOS from treating unfocused BrowserWindows as occluded (which triggers renderer freezing/throttling regardless of `backgroundThrottling: false`)
- `SpareRendererForSitePerProcess` — Prevents unnecessary spare renderer processes

GPU flags are centralized in `gpu-flags.ts` with typed constants and a `FORBIDDEN_GPU_SWITCHES` list to prevent accidental regression:

```typescript
export const DISABLED_CHROMIUM_FEATURES = [
  'MacWebContentsOcclusion',
  'SpareRendererForSitePerProcess',
] as const satisfies readonly string[];

export const FORBIDDEN_GPU_SWITCHES = [
  'enable-gpu-rasterization',
  'enable-zero-copy',
] as const satisfies readonly string[];
```

### Fix 3: Power State Awareness (Suspend/Resume)

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`

Added Electron `powerMonitor` event handlers:
- `suspend` → sends `app:power-state` IPC to renderer
- `resume` → sends `app:power-state` IPC (with 2s delay for OS/GPU settle time)
- `lock-screen` / `unlock-screen` → logged for diagnostics

Preload bridge exposes `power.onPowerState(callback)` to the renderer via `contextBridge`.

### Fix 4: GPU Keep-Alive Pause During Suspend

**File:** `packages/embedding-worker/src/embedding.worker.ts`

Added a `keepAlivePaused` flag toggled via `BroadcastChannel('power-state')`:
- On `suspend`: pauses GPU command submission (avoids submitting to a stale device)
- On `resume`: resumes GPU command submission

Also guards against concurrent GPU access: `isInferenceActive` prevents the keep-alive from submitting commands while an embedding operation is in progress.

### Fix 5: File Watcher Event Batching + Async I/O

**File:** `packages/file-system/src/adapters/electron-watchers.ts`

Replaced per-event callbacks with batched delivery:
- `fs.existsSync()` + `fs.statSync()` → `fs.promises.stat()` (async, non-blocking)
- Events accumulate over a **150ms window** before being delivered as a single batch
- Flush remaining batch on dispose (stop function)
- Null filenames silently ignored
- `rename` + stat failure → `removed` event; `change` + stat failure → silently dropped

### Fix 6: Live Query IPC Throttling When Backgrounded

**File:** `apps/desktop/src/ipc-handlers.ts`

When the window loses focus, PGlite live subscriptions are **paused** (not just queued — fully paused via `sub.unsubscribe()`). On focus, they're **resumed** via `sub.subscribe()`.

Wire-up in `main.ts`:
```typescript
mainWindow.on('blur', () => setBackgrounded(true));
mainWindow.on('focus', () => setBackgrounded(false));
```

---

## Test Coverage

All fixes have dedicated tests:

| Area | Test File | Tests |
|------|-----------|-------|
| GPU flag drift protection | `__tests__/gpu-flags.test.ts` | Forbidden flags not in disabled set, expected features present |
| GPU flag assertions | `__tests__/main/window-setup.test.ts` | Verifies disable-features flags, no forbidden GPU switches |
| Deferred crash recovery | `__tests__/create-window.test.ts` | Focus/activate triggers, killed/clean-exit exclusion, crash counter reset, isDestroyed guard |
| Worker keep-alive guards | `embedding-worker/test/embedding.worker.runtime.spec.ts` | keepAlivePaused suppression, isInferenceActive suppression |
| Power bridge (preload) | `__tests__/preload-power.test.ts` | contextBridge exposure, IPC subscription, state forwarding, cleanup |
| useAppActive hook | `packages/hooks/src/__tests__/use-app-active.test.ts` | Focus/visibility states, visibilitychange, blur/focus events |
| File watcher batching | `packages/file-system/src/__tests__/electron-watchers.test.ts` | Coalescing, removed events, stop flush, null filename, directory detection |
| Live query backgrounding | `__tests__/main/ipc-handlers-db.test.ts` | Pause/resume lifecycle, idempotent guard conditions |

---

## Confirmed Working

Log evidence shows the combined fix working:

```
power:suspend                                    ← Mac sleeps
[keep-alive paused]                              ← Worker stops GPU submissions
power:resume                                     ← Mac wakes (2s delay)
[keep-alive resumed]                             ← Worker resumes GPU submissions
GPU keep-alive tick #N                           ← Ticks continue normally
window:focus                                     ← User returns
[live queries resumed]                           ← IPC traffic resumes
```

- Zero SIGTRAP crashes (10+ minutes idle)
- Zero beach ball freezes (sleep/wake cycles)
- Zero sync I/O floods on wake
- GPU keep-alive reliable through sleep/wake transitions

---

## Key Technical Details

### ONNX Runtime WebGPU device access path

```
env.backends.onnx.webgpu.device  →  Promise<GPUDevice>
```

- Transformers.js exposes the ONNX Runtime env at `env.backends.onnx`
- ONNX Runtime freezes `env.webgpu.device` via `Object.defineProperty({ writable: false, configurable: false })` after first inference session
- Device cannot be replaced in the same worker — recovery requires worker restart

### MacWebContentsOcclusion (Chromium feature)

On macOS, Chromium detects when a BrowserWindow is fully covered by another window and marks it as "occluded". Occluded renderers receive aggressive throttling similar to background tabs, **regardless of `backgroundThrottling: false`**. Disabling this feature ensures the renderer stays active when covered.

### Why deferred recovery, not immediate reload

Calling `win.webContents.reload()` synchronously inside the `render-process-gone` handler while the window is backgrounded can trigger a permanent main thread freeze. The OS may deliver additional POSIX signals during the reload, creating a signal storm. Deferring to user focus/activate ensures the reload happens during a clean main thread state.

---

## Files Modified

| File | Change |
|------|--------|
| `apps/desktop/src/gpu-flags.ts` | **NEW** — Centralized GPU flag constants with forbidden flags guard |
| `apps/desktop/src/main.ts` | powerMonitor events, window blur/focus, GPU flag imports, `setBackgrounded` wiring |
| `apps/desktop/src/preload.ts` | Power state IPC bridge via contextBridge |
| `apps/desktop/src/create-window.ts` | `backgroundThrottling: false`, deferred crash recovery with focus/activate triggers |
| `apps/desktop/src/ipc-handlers.ts` | Live query pause/resume on background/foreground |
| `packages/embedding-worker/src/embedding.worker.ts` | Keep-alive pause/resume, isInferenceActive guard, BroadcastChannel power handler |
| `packages/file-system/src/adapters/electron-watchers.ts` | Async I/O + 150ms event batching |
| `packages/hooks/src/use-app-active.ts` | App active state hook (useSyncExternalStore) |
| `packages/queue/src/adapters/browser-workerpool.ts` | `minWorkers: 1` (from earlier fix, kept) |

---

## References

- WebGPU device loss spec: https://gpuweb.github.io/gpuweb/#dom-gpudevice-lost
- WebGPU device loss best practices: https://toji.dev/webgpu-best-practices/device-loss.html
- ONNX Runtime WebGPU EP: https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- ONNX Runtime WebGPU flags API: https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html
- Chromium background throttling: https://developer.chrome.com/blog/background-tabs/
- Electron BrowserWindow backgroundThrottling: https://www.electronjs.org/docs/latest/api/browser-window
- Chromium MacWebContentsOcclusion: https://chromium.googlesource.com/chromium/src/+/main/content/browser/web_contents/web_contents_impl.cc
