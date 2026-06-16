# BST-364 Background Throttling, Power, and QoS Research

Date: 2026-05-08

## Scope

This note researches `BST-364: Restore backgroundThrottling for main window and gate powerSaveBlocker` before implementation. It covers the current Brainstrike desktop architecture, database QoS and background indexing behavior, and current upstream guidance as of May 2026.

The key constraint is not "stop background indexing." Brainstrike is local-first and background indexing is a product feature. The better target is to keep background indexing alive while ensuring the visible renderer and foreground database work stay first-class.

## Current Code State

The current app already reflects most of the target architecture:

- Visible desktop window keeps Chromium background throttling enabled. `apps/desktop/src/create-window.ts` creates the primary `BrowserWindow` with `backgroundThrottling: true` in `webPreferences`.
- Hidden renderer hosts disable throttling. `apps/desktop/src/renderer-host-lifecycle.ts` sets `backgroundThrottling: false` only on the small hidden host window.
- Main process does not run embeddings. `apps/desktop/src/main.ts` states that embedding worker configuration remains renderer-only through the hidden embedding host.
- `apps/desktop/src/embedding-host-manager.ts` scopes `powerSaveBlocker` to `status.state === 'running' && status.active`, uses `prevent-app-suspension`, and stops the blocker after a 5 second sustained idle grace.
- Unit tests already cover the blocker lifecycle in `apps/desktop/src/__tests__/embedding-host-manager.test.ts`: short idle gaps keep the blocker active, sustained idle stops it, and error/stopped states stop it immediately.
- Desktop embedding worker config requires QoS scheduler snapshots and fails fast if unavailable. `apps/desktop/src/renderer/components/embedding-worker-config.ts` throws if no scheduler snapshot source exists.
- Desktop embedding worker config adapts to DB pressure: idle claim size is 16, pressured claim size is 1, inter-batch delay is 75 ms, and foreground pressure is detected from scheduler quiet windows and latency samples.
- The embedding worker calls `waitForBackgroundPermit('embedding claim')` before claiming queue work and `waitForBackgroundPermit('embedding completion')` before completion persistence.
- Background indexing uses a priority DB handle and the same pressure controller. `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx` creates `createPriorityDbHandle(db, 'background')` and requires scheduler snapshots.
- Background indexing has explicit pause/cancel paths through the shared background work arbiter. This means "pause when foreground work demands it" exists already and should not be replaced by disabling the feature.

## Upstream Guidance

### Electron backgroundThrottling

Electron documents that `backgroundThrottling` defaults to `true` and controls whether animations and timers are throttled when a page becomes backgrounded. It also affects the Page Visibility API. Electron also warns that if any webContents displayed in a single BrowserWindow disables background throttling, the whole BrowserWindow continues drawing and swapping frames. Source: [Electron BrowserWindow options](https://www.electronjs.org/docs/latest/api/structures/browser-window-options).

Electron's BrowserWindow docs add two important details:

- On macOS, visibility tracks occlusion, so a fully covered window can become hidden.
- If `backgroundThrottling` is disabled, visibility stays visible even if minimized, occluded, or hidden.
- Electron recommends pausing expensive operations when visibility is hidden to reduce power use.

Source: [Electron BrowserWindow page visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility).

Implication for Brainstrike: do not disable background throttling on the visible UI window. If a subsystem needs unthrottled timers for WebGPU/Web Workers, isolate that subsystem in a hidden host renderer and keep it as narrow as possible.

### Electron powerSaveBlocker

Electron's `powerSaveBlocker` provides two levels:

- `prevent-app-suspension`: keeps the app active while allowing the display to sleep.
- `prevent-display-sleep`: stronger; keeps both system and screen active.

`prevent-display-sleep` has higher precedence if multiple blockers are active. Source: [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker).

Implication for Brainstrike: `prevent-app-suspension` is the right class for active embedding/background indexing work. It should not be held while the host is merely running and idle, and it should not keep the display awake.

### Chrome background policies and Page Lifecycle

Chrome's background-tab policy is intentionally power-driven. Chrome guidance says background work should be minimized unless necessary for the user experience, and Page Visibility should be used to suspend unnecessary work such as visual updates. Source: [Chrome background tabs](https://developer.chrome.com/blog/background_tabs/).

Chrome's Page Lifecycle guidance describes browser-initiated hidden, frozen, and discarded states as resource management tools. It recommends offloading non-UI work to idle periods or workers while active, and preparing for hidden/frozen/discarded transitions. Source: [Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

Chrome's timer throttling guidance specifically calls out polling as a common misuse of timers and recommends push/event mechanisms where possible. Hidden pages can see chained timers checked only once per second, and after longer hidden periods intensive throttling can check them once per minute. Source: [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/).

Implication for Brainstrike: avoid relying on frequent timers in visible UI when backgrounded. Prefer scheduler events, backoff, and DB/queue signals. For unavoidable long-running local compute, use the hidden host plus explicit activity reporting.

### MDN visibility, workers, and background tasks

MDN describes Page Visibility as a way to avoid unnecessary work when a document is not visible. It also notes that browsers commonly stop `requestAnimationFrame` callbacks and throttle timers in hidden pages. Source: [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API).

MDN describes Web Workers as background threads that can perform work without interfering with the UI thread. Source: [MDN Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

MDN's Background Tasks API (`requestIdleCallback`) lets user agents schedule work in free time, but it is not available in Web Workers. Source: [MDN Background Tasks API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Tasks_API).

Implication for Brainstrike: keeping embeddings in renderer/Web Worker context is correct, but `requestIdleCallback` is not a direct solution inside the worker. Brainstrike's DB scheduler and pressure controller are the right app-level QoS mechanism.

### WebGPU device loss

MDN's WebGPU guidance says many device losses are transient and apps should try to acquire a new device unless the device was intentionally destroyed. All resources tied to the lost device must be recreated. Source: [MDN GPUDevice.lost](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost).

Toji's WebGPU best practices recommend acquiring a fresh adapter immediately before requesting a device and, for background compute, restarting just the GPU portion of the application where possible instead of reloading the whole app. Source: [WebGPU device loss best practices](https://toji.dev/webgpu-best-practices/device-loss.html).

Implication for Brainstrike: the hidden embedding host and existing `destroyAndRestart()` path are idiomatic for isolating GPU lifecycle from the visible UI. The visible renderer should not be kept artificially visible just to protect WebGPU state.

## Architectural Finding

The shortest implementation path for BST-364 could be a tiny patch, but the code suggests the architecture may already be mostly correct. A safe implementation should first prove this contract and fill missing guardrails rather than blindly changing throttling or disabling background indexing.

Recommended contract:

1. Primary visible `BrowserWindow` must explicitly set `backgroundThrottling: true`.
2. Hidden embedding host may set `backgroundThrottling: false` because it owns local WebGPU/WASM embedding execution.
3. Main process must never start local embedding workers.
4. `powerSaveBlocker` may start only when the hidden host reports active embedding work.
5. `powerSaveBlocker` must stop after sustained idle, error, stop, dispose, or host process loss.
6. Background indexing remains enabled when user preferences enable it, but all indexing DB and embedding work must go through background-priority handles and pressure permits.
7. If QoS/scheduler snapshots are unavailable in desktop background paths, fail fast. Do not silently run unthrottled background work.

## Risks To Check Before Code Changes

- A stale code path may still set `backgroundThrottling: false` on the visible window in another branch, test fixture, or host-specific constructor.
- Host `active` may represent batch activity only. If there is meaningful work outside active batches, the blocker could stop too early; if `active` chatters between micro-batches, the grace timers must avoid start/stop churn.
- The current `powerSaveBlocker` is scoped to embedding host activity, not all background indexing. That is probably correct: file scanning/chunking/import DB work should yield through QoS and should not hold a system awake by default unless product explicitly says managed indexing must finish during OS sleep.
- Database QoS is cooperative. CPU/GPU inference still consumes resources between DB checkpoints. Claim-size pressure collapse and inter-batch delay reduce this, but they do not preempt an in-flight model inference batch.
- `backgroundThrottling: false` keeps the hidden host visible to Chromium's visibility model. That is acceptable only because the host is narrow and headless; it would be unacceptable on the visible app window.

## Proposed Implementation Shape

If implementation proceeds, I would avoid broad architecture changes unless tests reveal a real gap.

1. Add or tighten unit tests for visible window creation:
   - Assert primary `BrowserWindow.webPreferences.backgroundThrottling` is explicitly `true`.
   - Assert hidden host window explicitly sets `backgroundThrottling: false`.
2. Add or tighten unit tests for power lifecycle:
   - Host `running/active` starts `prevent-app-suspension`.
   - Host `running/inactive` stops after the idle grace.
   - Host `error`, `stopped`, closed window, and dispose stop immediately.
   - Short micro-batch idle gaps do not churn the blocker.
3. Add a desktop E2E or main-process integration assertion:
   - Start a small embedding-host backfill and observe start/stop blocker log lines.
   - Confirm visible window still works while background indexing is yielding to foreground DB work.
4. Add documentation or an invariant comment if missing:
   - Visible renderer must use default throttling.
   - Hidden host is the only exception because WebGPU/Web Worker local embeddings require renderer execution.
5. Do not disable background indexing.
6. Do not add a fallback path if QoS snapshots are unavailable.

## Manual Verification Plan

Manual validation should focus on behavior that unit tests cannot prove:

- Launch desktop in dev mode.
- Enable background indexing for a managed root.
- Start a small enough indexing job to observe active work without a long run.
- Use the app during indexing and confirm foreground UI and DB operations remain responsive.
- Minimize or occlude the visible window while the hidden host processes work; verify the host remains healthy.
- Confirm logs include blocker start only during active embedding work and blocker stop after idle.
- Confirm no blocker is active after cancel, pause, error, or app shutdown.

## Recommended Decision

Proceed with BST-364 as a contract-hardening PR, not as a feature-disabling PR. The expected code change may be mostly tests and documentation if the current implementation already satisfies the contract. If investigation finds that visible UI still needs unthrottled WebGPU for search embeddings, that is an architecture issue: move that work into a host/runtime boundary rather than re-disabling throttling on the primary window.
