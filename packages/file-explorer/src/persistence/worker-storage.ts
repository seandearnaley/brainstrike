/**
 * Worker-based Storage Adapter
 *
 * Provides a storage interface that offloads serialization and I/O operations
 * to a Web Worker to prevent UI blocking during large state saves.
 */

import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';

const logger = createLogger('worker-storage');

/**
 * Resolve the worker storage URL for Vite/bundler worker loading.
 *
 * WARNING: This function uses `import.meta.url` which is ESM-only. In CJS builds,
 * esbuild emits "empty-import-meta" warnings because `import.meta` is undefined in CJS.
 * This is INTENTIONAL and HARMLESS — this function is only called at runtime in browser
 * ESM environments (guarded by `initWorker` in worker-init.ts which checks for
 * `window` and non-test environments before calling this).
 *
 * The esbuild warning is suppressed in tsup.config.ts via `esbuildOptions.logOverride`.
 * DO NOT remove the suppression without verifying the warning is gone, and DO NOT try to
 * "fix" this by adding typeof guards around import.meta — the URL constructor needs a
 * real value, and the runtime guard in worker-init.ts is sufficient.
 */
export function resolveWorkerStorageUrl(): URL {
  return new URL('./worker-storage.worker.mjs', import.meta.url);
}

export interface WorkerMessage {
  id: string;
  key?: string | undefined;
  type: 'save' | 'load' | 'remove';
  value?: unknown;
}

export interface WorkerResponse {
  error?: string;
  id: string;
  result?: unknown;
  type: 'success' | 'error';
}

export interface StorageRequest {
  id: string;
  key: string;
  operation: 'setItem' | 'getItem' | 'removeItem';
  opId?: number;
  type: 'storage_request';
  value?: string;
}

export class WorkerStorage {
  private worker: Worker | null = null;
  private messageId = 0;
  private readonly storageAdapter: StorageAdapter;
  private readonly pendingSaveValues = new Map<string, unknown>();
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      key: string | undefined;
      type: 'save' | 'load' | 'remove';
      admitted: boolean;
      retired: boolean;
    }
  >();
  private readonly activeSaveOps = new Map<string, number>();
  private readonly adapterWrites = new Map<string, Promise<void>>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceState = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: () => void;
      reject: (reason?: unknown) => void;
      value: unknown;
      callers: { resolve: () => void; reject: (reason?: unknown) => void }[];
    }
  >();

  /**
   * Create a WorkerStorage instance.
   * @param workerUrl - Pre-resolved worker URL from `resolveWorkerStorageUrl()`.
   *   This parameter is required to ensure Vite can statically analyze the worker URL
   *   at the call site. Call `resolveWorkerStorageUrl()` before constructing.
   * @param storageAdapter - Canonical persistence adapter used for all actual reads/writes.
   *   The worker only offloads message handling and serialization; it does not own storage.
   *
   * @example
   * ```ts
   * const workerUrl = resolveWorkerStorageUrl();
   * const storage = new WorkerStorage(workerUrl, storageAdapter);
   * ```
   */
  constructor(workerUrl: URL, storageAdapter: StorageAdapter) {
    this.storageAdapter = storageAdapter;
    this.initializeWorker(workerUrl);
  }

  private initializeWorker(workerUrl: URL) {
    if (typeof Worker === 'undefined') {
      // Web Workers not supported
      return;
    }

    try {
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.registerWorkerListeners();
    } catch (error) {
      logger.warn('Failed to initialize Web Worker for state persistence:', error);
      this.worker = null;
    }
  }

  private registerWorkerListeners() {
    if (!this.worker) {
      return;
    }

    this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
    this.worker.addEventListener('error', this.handleWorkerError.bind(this));
  }

  private handleWorkerMessage(event: MessageEvent<WorkerResponse | StorageRequest>) {
    const { type } = event.data;

    if (type === 'storage_request') {
      void this.handleStorageRequest(event.data as StorageRequest);
    } else {
      this.handleWorkerResponse(event.data as WorkerResponse);
    }
  }

  private handleWorkerResponse({ id, type, result, error }: WorkerResponse) {
    const request = this.takePendingRequest(id);
    if (!request) {
      return;
    }
    if (type === 'success') {
      request.resolve(result);
    } else {
      request.reject(new Error(error || 'Unknown worker error'));
    }
  }

  private takePendingRequest(id: string) {
    const request = this.pendingRequests.get(id);

    if (!request) {
      // Silently ignore responses for requests that have already timed out
      return;
    }

    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }

    this.pendingRequests.delete(id);

    return request;
  }

  private async handleStorageRequest(data: StorageRequest) {
    const { id, operation, key, value, opId } = data;

    // A timed-out or retired request must never start a late adapter operation.
    const request = this.pendingRequests.get(id);
    if (!request || request.retired) {
      return;
    }

    try {
      switch (operation) {
        case 'setItem':
          await this.processSetItemRequest(id, key, value, opId);
          break;
        case 'getItem':
          await this.processGetItemRequest(id, key);
          break;
        case 'removeItem':
          await this.processRemoveItemRequest(id, key);
          break;
        default:
          break;
      }
    } catch (error) {
      this.takePendingRequest(id)?.reject(error);
    }
  }

  private async processSetItemRequest(
    id: string,
    key: string,
    value: string | undefined,
    opId?: number
  ) {
    const lastOp = this.activeSaveOps.get(key) ?? 0;
    // BST-459. The question both checks below ask is "did the sender give this
    // write a usable sequence number?", and `Number.isFinite` is the predicate
    // that answers it. Neither of the two obvious shorthands does:
    //
    //   `opId && …`            treats `0` as unsequenced. 0 is a legal value of
    //                          the declared `opId?: number`, so a stale write
    //                          carrying it was APPLIED over a newer one — this
    //                          guard failing open, which is the ticket's bug.
    //   `opId !== undefined`   admits anything else that arrives. The payload
    //                          crosses postMessage and is not type-checked at
    //                          runtime: `NaN` would be recorded, and since
    //                          `x < NaN` is always false the guard would then
    //                          stop firing for that key until the next valid
    //                          write; `''` would compare as 0 and SKIP a write
    //                          that should have landed.
    //
    // The in-repo producer emits `Date.now()` (worker-storage.worker.mjs), so
    // none of this is reachable today — but `StorageRequest` is exported, and
    // the natural move to a monotonic counter starts at 0.
    const sequenced = opId !== undefined && Number.isFinite(opId);
    if (sequenced && opId < lastOp) {
      this.handleWorkerResponse({ id, type: 'success' });
      return;
    }
    if (sequenced) {
      this.activeSaveOps.set(key, opId);
    }

    // If value is undefined, we still need to respond but shouldn't store anything
    if (value === undefined) {
      throw new Error('Cannot store undefined value');
    }

    const written = await this.writeToAdapter(
      key,
      () => this.storageAdapter.setItem(key, value),
      () => this.admitMutation(id)
    );
    // The adapter owns durability. Its ACK completes the save without another
    // worker hop that could time out after the write has already committed.
    if (written) {
      this.handleWorkerResponse({ id, type: 'success' });
    }
  }

  private admitMutation(id: string): boolean {
    const request = this.pendingRequests.get(id);
    if (!request || request.retired) {
      return false;
    }
    request.admitted = true;
    return true;
  }

  private async writeToAdapter(key: string, write: () => Promise<void>, admitted?: () => boolean) {
    const previous = this.adapterWrites.get(key);
    const joined = Promise.withResolvers<void>();
    this.adapterWrites.set(key, joined.promise);
    try {
      if (previous) {
        await previous;
      }
      if (admitted && !admitted()) {
        return false;
      }
      await write();
      return true;
    } finally {
      joined.resolve();
      if (this.adapterWrites.get(key) === joined.promise) {
        this.adapterWrites.delete(key);
      }
    }
  }

  private async processGetItemRequest(id: string, key: string) {
    const rawValue = await this.storageAdapter.getItem(key);
    this.worker?.postMessage({ id, operation: 'getItem', rawValue, type: 'storage_response' });
  }

  private async processRemoveItemRequest(id: string, key: string) {
    const removed = await this.writeToAdapter(
      key,
      () => this.storageAdapter.removeItem(key),
      () => this.admitMutation(id)
    );
    if (removed) {
      this.handleWorkerResponse({ id, type: 'success' });
    }
  }

  private handleWorkerError(error: ErrorEvent) {
    logger.error('Worker error occurred:', error.error || error.message);

    this.pendingSaveValues.clear();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      request.reject(new Error('Worker error occurred'));
    }
    this.pendingRequests.clear();

    // Clear orphaned timeout timers to prevent resource leaks
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();

    for (const { timer, reject } of this.debounceState.values()) {
      clearTimeout(timer);
      reject(new Error('Worker error occurred'));
    }
    this.debounceState.clear();
  }

  private clearTrackedPendingSave(key: string, value: unknown): void {
    if (this.pendingSaveValues.get(key) === value) {
      this.pendingSaveValues.delete(key);
    }
  }

  private detachPendingSaveCallers(key: string) {
    const callers: { resolve: (value?: unknown) => void; reject: (error: unknown) => void }[] = [];
    const debounced = this.debounceState.get(key);
    if (debounced) {
      clearTimeout(debounced.timer);
      this.debounceState.delete(key);
      callers.push(debounced);
    }
    for (const [id, pending] of this.pendingRequests) {
      if (pending.type === 'save' && pending.key === key && !pending.admitted) {
        // Fence late worker admission, retaining this caller's original deadline.
        pending.retired = true;
        callers.push({
          reject: (error) => this.takePendingRequest(id)?.reject(error),
          resolve: () => this.handleWorkerResponse({ id, type: 'success' }),
        });
      }
    }
    return callers;
  }

  private flushPendingSaveValues(): void {
    for (const [key, value] of this.pendingSaveValues.entries()) {
      const callers = this.detachPendingSaveCallers(key);
      const reject = (error: unknown) => {
        for (const caller of callers) {
          caller.reject(error);
        }
        logger.error('Failed to flush pending worker storage write:', { error });
      };
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        // Starts synchronous adapters immediately; an admitted asynchronous write
        // joins first so its old value cannot commit after this latest snapshot.
        this.writeToAdapter(key, () => this.storageAdapter.setItem(key, serialized)).then(() => {
          for (const caller of callers) {
            caller.resolve();
          }
        }, reject);
      } catch (error) {
        reject(error);
      }
    }
    this.pendingSaveValues.clear();
  }

  flushPendingWrites(): void {
    this.flushPendingSaveValues();
  }

  private sendMessage(
    type: 'save' | 'load' | 'remove',
    key?: string,
    value?: unknown
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Web Worker not available'));
        return;
      }

      const id = (++this.messageId).toString();
      this.pendingRequests.set(id, { admitted: false, key, reject, resolve, retired: false, type });

      const message: WorkerMessage = { id, type };
      if (key !== undefined) {
        message.key = key;
      }
      if (value !== undefined) {
        message.value = value;
      }

      this.worker.postMessage(message);

      // Set a timeout to prevent hanging requests
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.timeouts.delete(id);
          reject(new Error('Worker request timeout'));
        }
      }, 5000); // 5 s timeout – faster failure recovery

      this.timeouts.set(id, timeout);
    });
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    try {
      const result = await this.sendMessage('load', key);
      return result as T | null;
    } catch (error) {
      logger.error('Worker getItem failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        key,
      });
      const rawValue = await this.storageAdapter.getItem(key);
      if (!rawValue) {
        return null;
      }

      try {
        return JSON.parse(rawValue) as T;
      } catch {
        // If parsing fails, return the raw value as-is (for backward compatibility)
        return rawValue as T;
      }
    }
  }

  /**
   * Persist a value, debounced by key (100ms).
   *
   * Coalesced callers join the latest value's adapter ACK or rejection. A
   * successful completion means that latest value committed, not that every
   * superseded intermediate snapshot was written.
   */
  async setItem(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingSaveValues.set(key, value);

      const existing = this.debounceState.get(key);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const callers = existing?.callers ?? [];
      callers.push({ reject, resolve });
      const resolveCallers = () => {
        for (const caller of callers) {
          caller.resolve();
        }
      };
      const rejectCallers = (error: unknown) => {
        for (const caller of callers) {
          caller.reject(error);
        }
      };

      // Debounce rapid saves for the same key
      const timer = setTimeout(async () => {
        this.debounceState.delete(key);
        try {
          await this.sendMessage('save', key, value);
          this.clearTrackedPendingSave(key, value);
          resolveCallers();
        } catch (error) {
          this.clearTrackedPendingSave(key, value);
          logger.error('Worker setItem failed:', error);
          rejectCallers(error);
        }
      }, 100); // 100ms debounce

      this.debounceState.set(key, {
        callers,
        reject: rejectCallers,
        resolve: resolveCallers,
        timer,
        value,
      });
    });
  }

  async removeItem(key: string): Promise<void> {
    const callers = this.detachPendingSaveCallers(key);
    this.pendingSaveValues.delete(key);

    try {
      await this.sendMessage('remove', key);
      for (const caller of callers) {
        caller.resolve();
      }
    } catch (error) {
      logger.error('Worker removeItem failed:', error);
      for (const caller of callers) {
        caller.reject(error);
      }
      throw error;
    }
  }

  /**
   * Check if worker is available and functioning
   */
  get isWorkerAvailable(): boolean {
    return this.worker !== null;
  }

  /**
   * Cleanup worker resources
   */
  destroy() {
    this.flushPendingSaveValues();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [id, pending] of this.pendingRequests) {
      // An admitted mutation still owns its adapter ACK/error after the worker
      // retires. A queued save joined to the flush retains its original deadline.
      if (pending.admitted || pending.retired) {
        continue;
      }
      if (pending.type === 'remove') {
        pending.reject(new Error('Worker storage is closed'));
      }
      this.pendingRequests.delete(id);
    }

    // Resolve and clear all active debounce states to prevent memory leaks
    for (const { timer, resolve } of this.debounceState.values()) {
      clearTimeout(timer);
      resolve();
    }
    this.debounceState.clear();

    // Clear any remaining timeout timers
    for (const [id, timer] of this.timeouts) {
      if (this.pendingRequests.has(id)) {
        continue;
      }
      clearTimeout(timer);
      this.timeouts.delete(id);
    }
  }
}
