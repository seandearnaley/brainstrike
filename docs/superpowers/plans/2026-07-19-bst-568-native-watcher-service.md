# BST-568 Native Watcher Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed chokidar / `fs.watch` workspace watcher with one `@parcel/watcher`-based native service that is resource-bounded, explicit about lifecycle and failure, and shared by Explorer, background indexing, and Notes Vault — plus a typed IPC watcher-health protocol.

**Architecture:** A new `startParcelWatch` engine in `@brainstrike/file-system` sits behind the existing `watchDirectory(handle, cb) => disposer` contract, reusing the existing 150ms/500-item batcher and `shouldIgnorePath` rules. Backend is selected explicitly per OS (`fs-events`/`inotify`/`windows`), the native binding is lazily loaded and validated (throw, never silently fall back), subscribe is bounded by a 10s timeout with late-resolution cleanup, and subscriptions live in a scoped registry keyed by root. A typed health event (`starting|healthy|degraded|failed|stopped`) flows over a new one-way IPC channel scoped to the owning WebContents, surfaced in Explorer with a deliberate retry action and bounded backoff.

**Tech Stack:** TypeScript strict, `@parcel/watcher` (NAPI prebuilds), Electron 43 main-process IPC, Vitest (unit + `*.integration.test.ts`), React 19 renderer UX.

## Global Constraints

- **NO SILENT FALLBACKS** — unsupported platform, missing binding, subscribe timeout/failure, runtime backend failure all throw or surface visibly. No polling fallback (ticket non-goal).
- Preserve verbatim: `FileSystemChange` contract (`packages/types/src/file-system.ts:223-227`), `FS_WATCH_BATCH_WINDOW_MS = 150`, `FS_WATCH_MAX_BATCH_SIZE = 500`, `fileFilter.shouldIgnorePath` ignore rules (no broadening), `MAX_FS_WATCHERS_PER_OWNER = 32`, owner-only IPC push, reaper-before-await lifecycle.
- Local inference / Mastra untouched. No Explorer tree rewrite. No new round-trip API dependency on the watch path.
- Each slice = its own PR on a `BST-568/*` branch, red/green TDD, opus pre-PR review, merged before next slice builds on it.
- Bar per slice: clean build + lint + type check + unit tests green in the same run (`pnpm turbo run build lint type-check test --filter=...`).
- Docs: `docs/agents/explorer-search-tapestry.md` (watcher invariants section) updated in the slice that changes behavior it documents; final consolidation in slice 5.
- Every new persistent store (none planned) would need factory-reset wiring; telemetry counters are in-memory only, deliberately.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/file-system/src/adapters/parcel-backend.ts` (new) | Backend name selection per OS (throw on unsupported), lazy binding load + validation, typed `ParcelWatcherUnavailableError`. |
| `packages/file-system/src/adapters/parcel-watchers.ts` (new) | `startParcelWatch(handle, callback, options)` — subscribe with 10s timeout + late-resolution cleanup, event normalization into `FileSystemChange` via the existing batcher, ignore rules, root-invalidation for pathless/error events, health callbacks. |
| `packages/file-system/src/adapters/electron-watchers.ts` | Existing batcher + legacy engines; batcher stays the shared primitive. Chokidar engine deleted in slice 4. |
| `packages/file-system/src/adapters/electron-adapter.ts:537-582` | Routing: legacy default until slice 4, explicit `BRAINSTRIKE_WATCHER_BACKEND` override (malformed → throw) from slice 2, parcel default in slice 4. |
| `packages/types/src/file-system.ts` | + `WatcherHealthState`, `WatcherFailure`, `WatcherHealthEvent`, `WatcherTelemetrySnapshot` (slice 3). |
| `apps/desktop/src/ipc-domains/file-system-watch-ipc.ts` | + `fs:watch-health` one-way push to owner, retry command, bounded backoff state (slice 3). |
| `packages/file-explorer-ui/src/shell/watcher-health-status.tsx` (new) | Explorer status indicator + retry action (slice 3). |
| `packages/file-system/scripts/watcher-benchmark.mjs` (new) | Synthetic large-tree benchmark harness (slice 1). |
| `packages/file-system/scripts/validate-parcel-binding.mjs` (new) | Packaging-matrix binding validation, runnable in CI and packaged app (slice 1). |
| `docs/agents/research/bst-568-parcel-watcher-spike.md` (new) | Spike findings + packaging matrix (slice 1). |

---

## Slice 1 — `BST-568/parcel-watcher-spike`: dep, packaging matrix, benchmark

### Task 1.1: Add `@parcel/watcher` and binding validation

**Files:**
- Modify: `packages/file-system/package.json` (add `"@parcel/watcher": "^2.5.1"` to `dependencies`)
- Create: `packages/file-system/scripts/validate-parcel-binding.mjs`
- Test: `packages/file-system/src/__tests__/parcel-binding.integration.test.ts`

**Interfaces:**
- Produces: `validate-parcel-binding.mjs` exits 0 printing `{ platform, arch, backend, subscribeMs }` JSON, non-zero with a structured error otherwise. Integration test asserts real subscribe/unsubscribe works on the host OS.

- [ ] Write failing integration test: imports `@parcel/watcher`, subscribes to a temp dir with the explicit host backend, touches a file, asserts an event arrives < 5s, unsubscribes.
- [ ] `pnpm add @parcel/watcher@^2.5.1 --filter @brainstrike/file-system`; run test → PASS.
- [ ] Write `validate-parcel-binding.mjs` (same check as CLI, JSON output, explicit backend per OS, non-zero exit + error JSON on failure). Wire as package script `validate:parcel-binding`.
- [ ] Commit.

### Task 1.2: Synthetic large-tree benchmark

**Files:**
- Create: `packages/file-system/scripts/watcher-benchmark.mjs`
- Test: `packages/file-system/src/__tests__/watcher-benchmark-tree.test.ts` (tree generator unit test, small N)

**Interfaces:**
- Produces: `node scripts/watcher-benchmark.mjs --dirs 30000 --files-per-dir 2` prints JSON `{ dirs, files, subscribeMs, rssMb, firstEventMs, eventsPerSec, backend }` for (a) parcel and (b) the current engine for comparison.

- [ ] Failing unit test for `generateSyntheticTree(root, {dirs, filesPerDir})` helper (exported from the script file as a lib function): creates exact counts, bounded fanout.
- [ ] Implement generator + benchmark runner; run at small scale locally, record 30k-dir numbers into the spike doc.
- [ ] Write `docs/agents/research/bst-568-parcel-watcher-spike.md`: packaging matrix (darwin-arm64/x64, linux-x64/arm64 glibc+musl, win32-x64 — which prebuild optional dep serves each), electron/NAPI note (no ABI rebuild needed; asarUnpack requirement recorded for slice 4), benchmark numbers, EMFILE behavior note.
- [ ] Commit. Full gate (`build lint type-check test`) green → opus review → PR → merge.

## Slice 2 — `BST-568/parcel-adapter`: adapter behind existing contract, no UI change

### Task 2.1: Backend selection + lazy binding module

**Files:**
- Create: `packages/file-system/src/adapters/parcel-backend.ts`
- Test: `packages/file-system/src/__tests__/parcel-backend.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ParcelBackendName = 'fs-events' | 'inotify' | 'windows';
  export function selectParcelBackend(platform: NodeJS.Platform): ParcelBackendName; // throws ParcelWatcherUnavailableError on unsupported
  export class ParcelWatcherUnavailableError extends Error { readonly code: 'unsupported-platform' | 'binding-load-failed'; }
  export function loadParcelWatcher(): Promise<typeof import('@parcel/watcher')>; // lazy, cached, throws ParcelWatcherUnavailableError('binding-load-failed') with cause
  ```
- [ ] Failing tests: darwin→fs-events, linux→inotify, win32→windows, freebsd→throws with code `unsupported-platform`; load failure surfaces cause, never returns undefined.
- [ ] Implement; green; commit.

### Task 2.2: `startParcelWatch` engine

**Files:**
- Create: `packages/file-system/src/adapters/parcel-watchers.ts`
- Test: `packages/file-system/src/__tests__/parcel-watchers.test.ts` (mocked binding), `packages/file-system/src/__tests__/parcel-watchers.integration.test.ts` (real binding, temp dirs)

**Interfaces:**
- Consumes: `createFileSystemChangeBatcher`, `fileFilter.shouldIgnorePath`, `selectParcelBackend`, `loadParcelWatcher`.
- Produces:
  ```ts
  export const PARCEL_SUBSCRIBE_TIMEOUT_MS = 10_000;
  export interface ParcelWatchOptions { onHealth?: (event: ParcelWatchHealth) => void }
  export function startParcelWatch(handle: DirectoryHandle, callback: (changes: FileSystemChange[]) => void, options?: ParcelWatchOptions): Promise<() => void>;
  ```
- Normalization: `create`→stat→added(file|dir); stat-miss→`{kind:'directory',path,type:'removed'}`; `update`→modified(file) (stat for kind); `delete`→`{kind:'directory',path,type:'removed'}` (safe-invalidation idiom, parity with existing native path); parcel error event→root invalidation `{kind:'directory',path:root,type:'modified'}` + stop + one structured log. Events serialized through a promise queue like `nativeEventQueue`.
- Ignore: post-hoc `shouldIgnorePath` authoritative; identical segment names passed as parcel `ignore` globs (resource saving, not broadening).
- Timeout: reject after 10s with structured error; if the underlying subscribe later resolves, unsubscribe it (late-resolution cleanup). Disposer is idempotent; dispose-before-ready unsubscribes on arrival.
- [ ] Failing unit tests (mocked binding) for every behavior above, one per test.
- [ ] Implement minimal engine; green.
- [ ] Integration test: real subscribe on temp tree — add/modify/delete file and dir, assert normalized batches; dispose stops events.
- [ ] Commit.

### Task 2.3: Explicit backend routing (no default change)

**Files:**
- Modify: `packages/file-system/src/adapters/electron-adapter.ts:537-582`
- Test: extend `packages/file-system/src/__tests__/electron-adapter.test.ts`

**Interfaces:**
- Produces: `resolveWatcherBackend(env): 'legacy' | 'parcel'` — `BRAINSTRIKE_WATCHER_BACKEND` unset → `legacy`; `parcel`/`legacy` → as named; anything else → throw (no silent coercion). `watchDirectory` routes to `startParcelWatch` when `parcel`.
- [ ] Failing tests: unset→legacy routing preserved (darwin native + other chokidar), `parcel`→parcel engine, `garbage`→throw.
- [ ] Implement; green; commit. Full gate → opus review → PR → merge.

## Slice 3 — `BST-568/watcher-health-ipc`: typed health protocol + renderer UX

### Task 3.1: Types + engine health emission

- `packages/types/src/file-system.ts` +:
  ```ts
  export type WatcherHealthState = 'starting' | 'healthy' | 'degraded' | 'failed' | 'stopped';
  export interface WatcherFailure { code: string; message: string; retryable: boolean; terminal: boolean; }
  export interface WatcherHealthEvent { watchId: string; backend: 'fs-events' | 'inotify' | 'windows' | 'legacy-chokidar' | 'legacy-fs-watch'; state: WatcherHealthState; failure?: WatcherFailure; timestamp: number; }
  export interface WatcherTelemetrySnapshot { activeWatchers: number; backend: string; setupLatencyMs: number[]; eventCount: number; batchCount: number; rootInvalidations: number; failures: number; retries: number; cleanups: number; }
  ```
- Engines emit health transitions exactly once per state change (`starting→healthy`, `→degraded` on root invalidation, `→failed` with structured failure, `→stopped` on dispose). TDD per transition.

### Task 3.2: IPC push + retry + backoff

- `apps/desktop/src/ipc-domains/file-system-watch-ipc.ts`: new one-way `fs:watch-health` push (owner-scoped, `isDestroyed` guarded, no cross-renderer root-path leakage); `fs:watch-retry` invoke (owner-validated like unwatch); bounded backoff 1s/5s/30s, max 3 auto-retries per root then manual-only; at most one active subscription-or-retry per root (in-flight guard). Telemetry snapshot over existing invoke pattern. TDD in `apps/desktop/src/__tests__/ipc-domains/file-system-watch-ipc.test.ts` style.
- Preload bridge + `ElectronFileSystemAPI` (`onWatchHealth`, `retryWatch`, `getWatcherTelemetry`), renderer shared-dispatcher fan-out by watchId (mirror `adapters.ts:31-63`).

### Task 3.3: Explorer status UX

- `packages/file-explorer-ui/src/shell/watcher-health-status.tsx`: per-root status chip (only non-healthy states render), retry button wired to `retryWatch`, failure detail tooltip. Testing-library tests: failed root renders chip + retry invokes API; healthy renders nothing. Manual chrome-devtools verification in the PR loop. Full gate → opus review → PR → merge.

## Slice 4 — `BST-568/native-default`: switch platforms, remove chokidar

- Flip `resolveWatcherBackend` default to `parcel` (all OS); `legacy` remains as explicit escape hatch for one release? **No** — ticket says remove chokidar after parity + packaged proof: delete `startChokidarWatch` + chokidar dep; keep `startFsWatch` deleted too (parcel owns all three OSes); `legacy` value now throws `unsupported` (no silent fallback). Update `electron-watchers.test.ts` / adapter tests accordingly.
- Packaged-app proof: `apps/desktop/package.json` electron-builder `asarUnpack` + `**/node_modules/@parcel/watcher*/**/*.node`; run `validate:parcel-binding` inside packaged smoke (existing desktop E2E smoke hook); mac local + Windows/Linux via user's testers before merge.
- Benchmark re-run recorded in spike doc. Full gate → opus review → PR → merge.

## Slice 5 — `BST-568/watcher-hardening-docs`: telemetry hardening + docs

- Telemetry counters complete + covered (event rate, batch drops, invalidations, failures, retries, cleanup); exactly-once-per-transition logging audit; leak test: root removal / renderer destruction / reload / shutdown leave zero subscriptions (extend reaper tests to parcel engine).
- Docs: rewrite watcher section of `docs/agents/explorer-search-tapestry.md` (settled invariants incl. health protocol), add lifecycle notes to `docs/agents/platform-contracts.md`. 10-minute six-root soak procedure recorded; run on real profile. Full gate → opus review → PR → merge. Linear → Done.

## Self-Review Notes

- Spec coverage: all 5 ticket slices mapped; acceptance criteria traced (contract tests slice 2, health/failure tests slice 3, packaged binding checks slices 1+4, leak/soak slice 5, docs slice 5). Non-goals honored (no polling, no tree rewrite, no Mastra).
- Types consistent: `FileSystemChange` untouched; health types defined once in slice 3 and consumed by 3.2/3.3.
- Deliberate deviation from skill granularity: slices 3–5 hold exact interfaces and test intent but fewer verbatim code blocks — they depend on review outcomes of slices 1–2; refine each slice's tasks to full granularity when its predecessor merges.
