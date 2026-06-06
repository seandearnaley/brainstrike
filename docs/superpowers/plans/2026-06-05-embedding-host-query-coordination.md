# Embedding-Host Query/Indexing Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the desktop background embedding indexer from sharing the GPU with the assistant's query embeddings — when a query embedding is requested, the indexer holds new batches and the in-flight batch is drained first, so the GPU is exclusively the query's.

**Architecture:** A small ref-counted "foreground gate" closes while a query embedding is in flight. The embedding worker's existing `waitForBackgroundPermit('embedding claim')` additionally waits on the gate (no new batch starts). The query handler drains the current batch by waiting for the worker's `active` flag to clear (bounded) before generating. All coordination logic lives in one pure, unit-tested module; the host change is thin wiring.

**Tech Stack:** TypeScript (strict), Vitest, React 19 (Electron renderer), PGlite, Transformers.js/WebGPU. pnpm workspaces + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-05-embedding-host-query-coordination-design.md`

**Conventions verified in repo:**
- Embeddings unit tests run in the embeddings vitest project: `cd packages/embeddings && pnpm vitest run <path>`.
- Worker calls `waitForBackgroundPermit({label})` with label `'embedding claim'` before claiming ([embedding-worker.ts:1374](../../../packages/embeddings/src/worker/embedding-worker.ts)) and `'embedding completion'` before writing (line 892). Inference is wrapped by `beginActiveBatch`/`endActiveBatch` → `onWorkerActivityChange(active)` (lines 178-194, 1394-1398): `active===true` only during inference.
- Host wires the permit from `createEmbeddingWorkerConfig(db)` → `createDesktopPressureControls` → `pressureController.waitForBackgroundPermit` ([embedding-worker-config.ts:126](../../../apps/desktop/src/renderer/components/embedding-worker-config.ts)).
- Host tracks worker activity in `activeRef` and handles queries in `handleQueryEmbeddingRequest` ([embedding-host-runtime.tsx:338](../../../apps/desktop/src/renderer/components/embedding-host-runtime.tsx)); the query embedder is already cached by `modelKey` (lines 312-336).
- Repo uses Biome/ultracite: `pnpm dlx ultracite fix <paths>`; it alphabetizes object/interface properties — accept it.
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/embeddings/src/worker/foreground-embedding-gate.ts` | Pure coordination: gate + `waitForWorkerIdle` + `runCoordinatedQueryEmbedding` | New |
| `packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts` | Unit tests for all three | New |
| `packages/embeddings/src/worker/embedding-worker.ts` | Export the new module's public API from the worker entry (re-export) | Modify (export block near line 116-118) |
| `apps/desktop/src/renderer/components/embedding-worker-config.ts` | Accept a `gate`; compose it into the `'embedding claim'` permit | Modify (~line 109-130) |
| `apps/desktop/src/renderer/components/__tests__/embedding-worker-config.spec.ts` | Test the composed permit (claim waits on gate; other labels pass) | New (or add to existing if present) |
| `apps/desktop/src/renderer/components/embedding-host-runtime.tsx` | Create the gate; thread to worker config + query handler; drain before query | Modify (~lines 338-386, 412-464, 496-532) |
| `AGENTS.md` | Document the foreground-query coordination invariant | Modify (EMBEDDING ARCHITECTURE section) |

---

## Task 1: Foreground gate + drain + coordinated-query wrapper (pure module)

**Files:**
- Create: `packages/embeddings/src/worker/foreground-embedding-gate.ts`
- Test: `packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts
import { describe, expect, it, vi } from 'vitest';
import {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from '../foreground-embedding-gate';

describe('createForegroundEmbeddingGate', () => {
  it('is inactive initially and waitUntilInactive resolves immediately', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 10 });
    expect(gate.isActive()).toBe(false);
    await expect(gate.waitUntilInactive()).resolves.toBeUndefined();
  });

  it('closes on begin and reopens after the debounce on end', async () => {
    vi.useFakeTimers();
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 50 });
    gate.begin();
    expect(gate.isActive()).toBe(true);
    let resolved = false;
    const waiter = gate.waitUntilInactive().then(() => {
      resolved = true;
    });
    gate.end();
    expect(gate.isActive()).toBe(true); // still within debounce window
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await waiter;
    expect(resolved).toBe(true);
    expect(gate.isActive()).toBe(false);
    vi.useRealTimers();
  });

  it('ref-counts overlapping begins so the gate stays closed until all end', () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 10 });
    gate.begin();
    gate.begin();
    gate.end();
    expect(gate.isActive()).toBe(true);
  });

  it('a begin during the reopen debounce cancels the reopen', async () => {
    vi.useFakeTimers();
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 50 });
    gate.begin();
    gate.end();
    await vi.advanceTimersByTimeAsync(20);
    gate.begin(); // cancels pending reopen
    await vi.advanceTimersByTimeAsync(60);
    expect(gate.isActive()).toBe(true);
    vi.useRealTimers();
  });

  it('rejects a pending waitUntilInactive when the signal aborts', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1000 });
    gate.begin();
    const controller = new AbortController();
    const waiter = gate.waitUntilInactive({ signal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toThrow(/aborted/i);
  });
});

describe('waitForWorkerIdle', () => {
  it('resolves drained=true as soon as isActive is false', async () => {
    const res = await waitForWorkerIdle({ isActive: () => false, timeoutMs: 100, pollMs: 5 });
    expect(res.drained).toBe(true);
  });

  it('resolves drained=false on timeout when isActive stays true', async () => {
    const res = await waitForWorkerIdle({ isActive: () => true, timeoutMs: 30, pollMs: 5 });
    expect(res.drained).toBe(false);
  });

  it('resolves drained=true once isActive flips to false', async () => {
    let active = true;
    setTimeout(() => {
      active = false;
    }, 15);
    const res = await waitForWorkerIdle({ isActive: () => active, timeoutMs: 200, pollMs: 5 });
    expect(res.drained).toBe(true);
  });
});

describe('runCoordinatedQueryEmbedding', () => {
  it('drains before generating and always releases the gate', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 5 });
    const order: string[] = [];
    let active = true;
    setTimeout(() => {
      active = false;
    }, 10);
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => active,
      drainTimeoutMs: 200,
      pollMs: 2,
      generate: async () => {
        order.push(`generate(active=${active})`);
        return 42;
      },
    });
    expect(result).toBe(42);
    expect(order).toEqual(['generate(active=false)']); // generated only after drain
  });

  it('releases the gate even when generate throws', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1 });
    await expect(
      runCoordinatedQueryEmbedding({
        gate,
        isWorkerActive: () => false,
        drainTimeoutMs: 50,
        generate: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    // after the debounce, gate is inactive again
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.isActive()).toBe(false);
  });

  it('calls onDrainTimeout but still generates when drain times out', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1 });
    const onDrainTimeout = vi.fn();
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => true, // never drains
      drainTimeoutMs: 20,
      pollMs: 5,
      onDrainTimeout,
      generate: async () => 7,
    });
    expect(result).toBe(7);
    expect(onDrainTimeout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/embeddings && pnpm vitest run src/worker/__tests__/foreground-embedding-gate.spec.ts`
Expected: FAIL — `Cannot find module '../foreground-embedding-gate'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/embeddings/src/worker/foreground-embedding-gate.ts
/**
 * Coordinates the desktop background embedding indexer against foreground query
 * embeddings so they never share the GPU.
 *
 * - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so
 *   no NEW indexing batch starts while a query embedding is in flight.
 * - The query handler drains the current in-flight batch (waits for the worker's
 *   `active` flag to clear) before generating, so the GPU is exclusively the query's.
 *
 * Gating only the *claim* permit (never completion) keeps this deadlock-free: an
 * already-claimed batch always finishes and reports idle; only the next is held.
 */

interface ForegroundGateWaiter {
  reject: (reason: unknown) => void;
  resolve: () => void;
  cleanup: () => void;
}

export interface ForegroundEmbeddingGate {
  /** Mark a foreground query as in flight (ref-counted); closes the gate. */
  begin(): void;
  /** Release a foreground query; gate reopens after `reopenDelayMs` when count hits 0. */
  end(): void;
  /** True while any query is in flight OR within the post-release debounce window. */
  isActive(): boolean;
  /** Resolves immediately if inactive, else when the gate next reopens. Rejects on abort. */
  waitUntilInactive(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface ForegroundEmbeddingGateOptions {
  /** Debounce after the last query before reopening, so query bursts don't thrash indexing. */
  reopenDelayMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_REOPEN_DELAY_MS = 250;

export function createForegroundEmbeddingGate(
  options: ForegroundEmbeddingGateOptions = {}
): ForegroundEmbeddingGate {
  const reopenDelayMs = options.reopenDelayMs ?? DEFAULT_REOPEN_DELAY_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let count = 0;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<ForegroundGateWaiter>();

  const isActive = (): boolean => count > 0 || reopenTimer !== null;

  const clearReopenTimer = (): void => {
    if (reopenTimer !== null) {
      clearTimeoutFn(reopenTimer);
      reopenTimer = null;
    }
  };

  const flushWaiters = (): void => {
    for (const waiter of Array.from(waiters)) {
      waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve();
    }
  };

  const scheduleReopen = (): void => {
    clearReopenTimer();
    reopenTimer = setTimeoutFn(() => {
      reopenTimer = null;
      if (count === 0) {
        flushWaiters();
      }
    }, reopenDelayMs);
  };

  return {
    begin(): void {
      count += 1;
      clearReopenTimer();
    },
    end(): void {
      count = Math.max(0, count - 1);
      if (count === 0) {
        scheduleReopen();
      }
    },
    isActive,
    waitUntilInactive(waitOptions: { signal?: AbortSignal } = {}): Promise<void> {
      if (!isActive()) {
        return Promise.resolve();
      }
      const { signal } = waitOptions;
      if (signal?.aborted) {
        return Promise.reject(new Error('Foreground embedding gate wait aborted'));
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          waiters.delete(waiter);
          waiter.cleanup();
          reject(new Error('Foreground embedding gate wait aborted'));
        };
        const waiter: ForegroundGateWaiter = {
          resolve,
          reject,
          cleanup: () => {
            signal?.removeEventListener('abort', onAbort);
          },
        };
        waiters.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

export interface WaitForWorkerIdleOptions {
  isActive: () => boolean;
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_IDLE_POLL_MS = 25;

/**
 * Resolves `{drained:true}` as soon as `isActive()` is false; `{drained:false}` on timeout.
 * The timeout is a safety valve: the claim permit already blocks NEW batches, so proceeding
 * after a timeout is no worse than today.
 */
export function waitForWorkerIdle(
  options: WaitForWorkerIdleOptions
): Promise<{ drained: boolean }> {
  const pollMs = options.pollMs ?? DEFAULT_IDLE_POLL_MS;
  if (!options.isActive()) {
    return Promise.resolve({ drained: true });
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('waitForWorkerIdle aborted'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const poll = (): void => {
      if (!options.isActive()) {
        cleanup();
        resolve({ drained: true });
        return;
      }
      if (Date.now() - start >= options.timeoutMs) {
        cleanup();
        resolve({ drained: false });
        return;
      }
      pollTimer = setTimeout(poll, pollMs);
    };
    pollTimer = setTimeout(poll, pollMs);
  });
}

export interface RunCoordinatedQueryEmbeddingOptions<T> {
  gate: ForegroundEmbeddingGate;
  isWorkerActive: () => boolean;
  drainTimeoutMs: number;
  generate: () => Promise<T>;
  onDrainTimeout?: () => void;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * begin → drain the in-flight batch → generate → (finally) end. The gate is always
 * released, even if generate throws or the drain times out.
 */
export async function runCoordinatedQueryEmbedding<T>(
  options: RunCoordinatedQueryEmbeddingOptions<T>
): Promise<T> {
  options.gate.begin();
  try {
    const idleOptions: WaitForWorkerIdleOptions = {
      isActive: options.isWorkerActive,
      timeoutMs: options.drainTimeoutMs,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const { drained } = await waitForWorkerIdle(idleOptions);
    if (!drained) {
      options.onDrainTimeout?.();
    }
    return await options.generate();
  } finally {
    options.gate.end();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/embeddings && pnpm vitest run src/worker/__tests__/foreground-embedding-gate.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from the worker entry**

In `packages/embeddings/src/worker/embedding-worker.ts`, near the existing public exports (around lines 116-118 where `EmbeddingWorkerController`/`startEmbeddingWorker` are exported), add:

```ts
export {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from './foreground-embedding-gate';
export type {
  ForegroundEmbeddingGate,
  ForegroundEmbeddingGateOptions,
  RunCoordinatedQueryEmbeddingOptions,
  WaitForWorkerIdleOptions,
} from './foreground-embedding-gate';
```

Verify the worker entry still type-checks and the embeddings package builds the export:
Run: `cd packages/embeddings && pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Lint + commit**

```bash
pnpm dlx ultracite fix packages/embeddings/src/worker/foreground-embedding-gate.ts packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts
git add packages/embeddings/src/worker/foreground-embedding-gate.ts packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts packages/embeddings/src/worker/embedding-worker.ts
git commit -m "feat(embeddings): foreground embedding gate + drain + coordinated-query helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Compose the gate into the worker's claim permit

**Files:**
- Modify: `apps/desktop/src/renderer/components/embedding-worker-config.ts`
- Test: `apps/desktop/src/renderer/components/__tests__/embedding-worker-config.spec.ts`

**Goal:** `createEmbeddingWorkerConfig(db, gate?)` — when a `gate` is provided, the returned `waitForBackgroundPermit` additionally awaits `gate.waitUntilInactive()` for label `'embedding claim'` only. DB-pressure behavior and all other labels are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/components/__tests__/embedding-worker-config.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { composeClaimPermit } from '../embedding-worker-config';

describe('composeClaimPermit', () => {
  it('passes through non-claim labels without consulting the gate', async () => {
    const gate = { waitUntilInactive: vi.fn(async () => {}) };
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, gate as never);
    await permit({ label: 'embedding completion' });
    expect(base).toHaveBeenCalledTimes(1);
    expect(gate.waitUntilInactive).not.toHaveBeenCalled();
  });

  it('awaits the gate after the base permit for the claim label', async () => {
    const order: string[] = [];
    const gate = {
      waitUntilInactive: vi.fn(async () => {
        order.push('gate');
      }),
    };
    const base = vi.fn(async () => {
      order.push('base');
    });
    const permit = composeClaimPermit(base, gate as never);
    await permit({ label: 'embedding claim' });
    expect(order).toEqual(['base', 'gate']);
  });

  it('is a no-op wrapper when no gate is provided', async () => {
    const base = vi.fn(async () => {});
    const permit = composeClaimPermit(base, undefined);
    await permit({ label: 'embedding claim' });
    expect(base).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/renderer/components/__tests__/embedding-worker-config.spec.ts`
Expected: FAIL — `composeClaimPermit` is not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/components/embedding-worker-config.ts`:

Add the import at the top:
```ts
import type { ForegroundEmbeddingGate } from '@brainstrike/embeddings/worker';
```

Add this exported helper (above `createDesktopPressureControls`):
```ts
type BackgroundPermit = NonNullable<EmbeddingWorkerOptions['waitForBackgroundPermit']>;

/**
 * Wrap a DB-pressure permit so the worker also yields the GPU to an in-flight
 * foreground query embedding — but ONLY at the claim boundary (never completion),
 * which keeps draining deadlock-free.
 */
export function composeClaimPermit(
  base: BackgroundPermit,
  gate: ForegroundEmbeddingGate | undefined
): BackgroundPermit {
  if (!gate) {
    return base;
  }
  return async (permitOptions) => {
    await base(permitOptions);
    if (permitOptions?.label === 'embedding claim') {
      await gate.waitUntilInactive(
        permitOptions?.signal ? { signal: permitOptions.signal } : {}
      );
    }
  };
}
```

Change `createDesktopPressureControls` to accept the gate and compose the permit:
```ts
function createDesktopPressureControls(
  db: IDatabase,
  idleClaimBatchSize: number,
  gate: ForegroundEmbeddingGate | undefined
): Pick<EmbeddingWorkerOptions, 'resolveClaimBatchSize' | 'waitForBackgroundPermit'> {
  const snapshotSource = createPressureSnapshotSource(db);
  const pressureController = createDatabasePressureController({
    pollMs: DESKTOP_PRESSURE_POLL_MS,
    snapshotSource,
  });
  return {
    resolveClaimBatchSize: async () => {
      const snapshot = await snapshotSource.getSnapshot();
      if (hasForegroundDatabasePressure(snapshot)) {
        return DESKTOP_PRESSURED_EMBED_CLAIM_BATCH_SIZE;
      }
      return idleClaimBatchSize;
    },
    waitForBackgroundPermit: composeClaimPermit(pressureController.waitForBackgroundPermit, gate),
  };
}
```

Change `createEmbeddingWorkerConfig` to accept and forward the gate:
```ts
export function createEmbeddingWorkerConfig(
  db: IDatabase,
  gate?: ForegroundEmbeddingGate
): EmbeddingWorkerOptions {
  // ... unchanged env parsing ...
  return {
    db,
    claimBatchSize,
    concurrency,
    interBatchDelayMs,
    leaseMs,
    ...createDesktopPressureControls(db, claimBatchSize, gate),
    // ... unchanged rest ...
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/renderer/components/__tests__/embedding-worker-config.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint + type-check + commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/renderer/components/embedding-worker-config.ts apps/desktop/src/renderer/components/__tests__/embedding-worker-config.spec.ts
cd apps/desktop && pnpm exec tsc --noEmit
```
Expected: tsc exit 0.
```bash
git add apps/desktop/src/renderer/components/embedding-worker-config.ts apps/desktop/src/renderer/components/__tests__/embedding-worker-config.spec.ts
git commit -m "feat(desktop): gate the embedding claim permit on foreground query embeddings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the gate into the embedding host runtime

**Files:**
- Modify: `apps/desktop/src/renderer/components/embedding-host-runtime.tsx`

**Goal:** Create one gate per host runtime; pass it to `createEmbeddingWorkerConfig` and to the query handler; drain before generating via `runCoordinatedQueryEmbedding`.

This task is thin wiring (the logic is tested in Task 1/2). Verify via type-check + the existing embeddings/desktop suites (no behavior regressions).

- [ ] **Step 1: Add imports**

At the top of `embedding-host-runtime.tsx`, add to the `@brainstrike/embeddings` / worker imports:
```ts
import {
  createForegroundEmbeddingGate,
  type ForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
} from '@brainstrike/embeddings/worker';
```
(Match the existing import style/path used for `startEmbeddingWorker` — it is imported from `@brainstrike/embeddings` at line 7; if `startEmbeddingWorker`'s path differs from `/worker`, use whichever path actually re-exports the new symbols per Task 1 Step 5. Verify by reading the existing import.)

Add a module constant near the other constants:
```ts
const QUERY_DRAIN_TIMEOUT_MS = 5000;
```

- [ ] **Step 2: Thread the gate into the worker-start options**

In `StartEmbeddingHostWorkerOptions` (interface ~line 412), add:
```ts
  readonly gate: ForegroundEmbeddingGate;
```
In `startEmbeddingHostWorkerRuntime` destructure `gate` and pass it to the config:
```ts
    const workerConfig = createEmbeddingWorkerConfig(db, gate);
```
(replacing `createEmbeddingWorkerConfig(db)` at ~line 454).

- [ ] **Step 3: Drain + gate in the query handler**

In `handleQueryEmbeddingRequest` options (~line 338), add `readonly gate: ForegroundEmbeddingGate;` and destructure it.

Replace the inner generate sequence (currently lines ~366-371):
```ts
    const service = await getQueryEmbeddingService(db, request, runtimeIdRef, serviceStateRef);
    const result = await service.generateQueryEmbedding(request.payload.query);
    assertEmbeddingResultDimensions(request, result);
    reportQueryEmbeddingResponse(
      createEmbeddingHostQueryEmbeddingResultReport(request, result.embedding)
    );
```
with a coordinated version:
```ts
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => activeRef.current,
      drainTimeoutMs: QUERY_DRAIN_TIMEOUT_MS,
      onDrainTimeout: () => {
        logger.warn('Embedding host query proceeded before background drain completed', {
          requestId: request.requestId,
          runtimeId: request.runtimeId,
        });
      },
      generate: async () => {
        const service = await getQueryEmbeddingService(db, request, runtimeIdRef, serviceStateRef);
        const generated = await service.generateQueryEmbedding(request.payload.query);
        assertEmbeddingResultDimensions(request, generated);
        return generated;
      },
    });
    reportQueryEmbeddingResponse(
      createEmbeddingHostQueryEmbeddingResultReport(request, result.embedding)
    );
```
Leave the existing `queryEmbeddingActiveCountRef` increment/decrement, status reporting, try/catch error report, and the fatal/stale checks unchanged (the gate is independent of the count used for UI status).

- [ ] **Step 4: Create the gate and pass it through in the effect**

In `EmbeddingHostRuntime` (~line 496), add a ref alongside the others:
```ts
  const gateRef = useRef<ForegroundEmbeddingGate>(createForegroundEmbeddingGate());
```
In the effect, pass `gate: gateRef.current` to the `startEmbeddingHostWorkerRuntime({ ... })` call (~line 521) and to the `handleQueryEmbeddingRequest({ ... })` call (~line 622).

- [ ] **Step 5: Type-check + run the desktop renderer + embeddings suites**

Run:
```bash
cd apps/desktop && pnpm exec tsc --noEmit
cd apps/desktop && pnpm vitest run src/renderer/components
cd packages/embeddings && pnpm vitest run
```
Expected: tsc exit 0; all tests pass (no regressions).

- [ ] **Step 6: Lint + commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/renderer/components/embedding-host-runtime.tsx
git add apps/desktop/src/renderer/components/embedding-host-runtime.tsx
git commit -m "feat(desktop): coordinate query embeddings with background indexing in the host

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs + full gate + PR

**Files:**
- Modify: `AGENTS.md` (EMBEDDING ARCHITECTURE section)

- [ ] **Step 1: Document the invariant**

In `AGENTS.md`, under `## EMBEDDING ARCHITECTURE (CRITICAL)`, add a subsection after the "Job Queue" item:

```markdown
Foreground query coordination (desktop):
- The hidden host runs BOTH background indexing and assistant query embeddings.
- A foreground query must never share the GPU with background indexing.
- `createForegroundEmbeddingGate()` (packages/embeddings/src/worker/foreground-embedding-gate.ts):
  - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so no
    NEW indexing batch starts while a query is in flight (claim permit only — never the
    completion permit, which keeps draining deadlock-free).
  - The query handler drains the in-flight batch via `waitForWorkerIdle` (waits for the
    worker `active` flag, which is true only during inference) before generating.
- Constants: FOREGROUND_GATE_REOPEN_MS (250), QUERY_DRAIN_TIMEOUT_MS (5000).
```

- [ ] **Step 2: Run the full local gate (CI parity)**

Run from repo root:
```bash
pnpm type-check && pnpm lint:ci && pnpm build && pnpm test
```
Expected: all green together. Fix anything red and re-run the whole suite until clean. (`db#test` can flake under turbo concurrency — re-run in isolation if needed.)

- [ ] **Step 3: Commit docs**

```bash
git add AGENTS.md
git commit -m "docs: document desktop foreground query/indexing GPU coordination

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Push + PR + monitor CI**

```bash
git push -u origin harden/embedding-host-query-coordination
gh pr create --base main --fill
gh pr checks --watch
```
Fix any red checks and push until green.

---

## Self-Review (completed by author)

- **Spec coverage:** Gate + drain + coordinated wrapper → Task 1. Claim-permit composition (claim-only, DB unchanged) → Task 2. Host wiring (gate per runtime, threaded to config + query handler, drain before generate) → Task 3. Constants (`FOREGROUND_GATE_REOPEN_MS=250` via gate default `DEFAULT_REOPEN_DELAY_MS`, `QUERY_DRAIN_TIMEOUT_MS=5000`) → Tasks 1 & 3. Failure modes (drain timeout proceeds + logs; overlapping queries ref-count; query-throws releases gate; abort) → Task 1 tests. Docs → Task 4. Deterministic tests, no GPU e2e → Tasks 1 & 2.
- **Type consistency:** `createForegroundEmbeddingGate`/`ForegroundEmbeddingGate`/`waitUntilInactive`/`isActive`/`begin`/`end` consistent across Tasks 1-3. `composeClaimPermit`/`waitForBackgroundPermit` label `'embedding claim'` matches the worker's actual label. `runCoordinatedQueryEmbedding`/`waitForWorkerIdle`/`isWorkerActive`/`drainTimeoutMs` consistent across Tasks 1 & 3.
- **Note on import path:** Task 3 Step 1 flags verifying the exact re-export path (`@brainstrike/embeddings` vs `/worker`) against the existing `startEmbeddingWorker` import — the implementer confirms by reading line 7 before importing.
