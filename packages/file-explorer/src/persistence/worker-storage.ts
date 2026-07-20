/**
 * Worker-based Storage Adapter
 *
 * Provides a storage interface that offloads serialization and I/O operations
 * to a Web Worker to prevent UI blocking during large state saves.
 */

import type { StorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('worker-storage');

/**
 * Resolve the worker storage URL for Vite/bundler worker loading.
 *
 * WARNING: This function uses `import.meta.url` which is ESM-only. In CJS builds,
 * esbuild emits "empty-import-meta" warnings because `import.meta` is undefined in CJS.
 * This is INTENTIONAL and HARMLESS — this function is only called at runtime in browser
 * ESM environments (guarded by `initWorker` in worker-init.ts which checks for `window`,
 * non-test, non-Electron, and non-headless environments before calling this).
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
    }
  >();
  private readonly activeSaveOps = new Map<string, number>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceState = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: () => void;
      value: unknown;
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

    if (type === 'success') {
      request.resolve(result);
    } else {
      request.reject(new Error(error || 'Unknown worker error'));
    }
  }

  private async handleStorageRequest(data: StorageRequest) {
    const { id, operation, key, value, opId } = data;

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
      this.worker?.postMessage({
        error: error instanceof Error ? error.message : String(error),
        id,
        operation,
        success: false,
        type: 'storage_response',
      });
    }
  }

  private async processSetItemRequest(
    id: string,
    key: string,
    value: string | undefined,
    opId?: number
  ) {
    const lastOp = this.activeSaveOps.get(key) ?? 0;
    if (opId && opId < lastOp) {
      this.worker?.postMessage({
        id,
        operation: 'setItem',
        success: true,
        type: 'storage_response',
      });
      return;
    }
    if (opId) {
      this.activeSaveOps.set(key, opId);
    }

    // If value is undefined, we still need to respond but shouldn't store anything
    if (value === undefined) {
      this.worker?.postMessage({
        error: 'Cannot store undefined value',
        id,
        operation: 'setItem',
        success: false,
        type: 'storage_response',
      });
      return;
    }

    await this.storageAdapter.setItem(key, value);
    this.worker?.postMessage({ id, operation: 'setItem', success: true, type: 'storage_response' });
  }

  private async processGetItemRequest(id: string, key: string) {
    const rawValue = await this.storageAdapter.getItem(key);
    this.worker?.postMessage({ id, operation: 'getItem', rawValue, type: 'storage_response' });
  }

  private async processRemoveItemRequest(id: string, key: string) {
    await this.storageAdapter.removeItem(key);
    this.worker?.postMessage({
      id,
      operation: 'removeItem',
      success: true,
      type: 'storage_response',
    });
  }

  private handleWorkerError(error: ErrorEvent) {
    logger.error('Worker error occurred:', error.error || error.message);

    this.flushPendingSaveValues();

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

    // Resolve and clear pending debounced setItem callers immediately.
    for (const { timer, resolve } of this.debounceState.values()) {
      clearTimeout(timer);
      resolve();
    }
    this.debounceState.clear();
  }

  private clearTrackedPendingSave(key: string, value: unknown): void {
    if (this.pendingSaveValues.get(key) === value) {
      this.pendingSaveValues.delete(key);
    }
  }

  private flushPendingSaveValues(): void {
    for (const [key, value] of this.pendingSaveValues.entries()) {
      try {
        // Worker persistence is only enabled in browser contexts where the canonical
        // adapter is localStorage-backed. We flush synchronously on teardown so a
        // reload/pagehide cannot drop the latest debounced explorer settings.
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        void this.storageAdapter.setItem(key, serialized);
      } catch (error) {
        logger.error('Failed to flush pending worker storage write:', {
          error,
          key,
        });
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
      this.pendingRequests.set(id, { reject, resolve });

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
      logger.error('Worker getItem failed:', error);
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
   * When rapid calls supersede each other, the previous caller's Promise
   * resolves immediately (not rejected) even though that specific value
   * was never persisted. This is by design: callers should interpret a
   * resolved Promise as "the key will be persisted with the latest value,"
   * not "this exact value was written."
   */
  async setItem(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingSaveValues.set(key, value);

      // Resolve any superseded caller's Promise before replacing
      const existing = this.debounceState.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve();
      }

      // Debounce rapid saves for the same key
      const timer = setTimeout(async () => {
        this.debounceState.delete(key);
        try {
          await this.sendMessage('save', key, value);
          this.clearTrackedPendingSave(key, value);
          resolve();
        } catch (error) {
          logger.error('Worker setItem failed:', error);
          // Fallback path, ensure we store stringified value
          const serialized = typeof value === 'string' ? value : JSON.stringify(value);
          try {
            await this.storageAdapter.setItem(key, serialized);
            this.clearTrackedPendingSave(key, value);
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      }, 100); // 100ms debounce

      this.debounceState.set(key, { resolve, timer, value });
    });
  }

  async removeItem(key: string): Promise<void> {
    const existing = this.debounceState.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve();
      this.debounceState.delete(key);
    }
    this.pendingSaveValues.delete(key);

    try {
      await this.sendMessage('remove', key);
    } catch (error) {
      logger.error('Worker removeItem failed:', error);
      await this.storageAdapter.removeItem(key);
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
    this.pendingRequests.clear();

    // Resolve and clear all active debounce states to prevent memory leaks
    for (const { timer, resolve } of this.debounceState.values()) {
      clearTimeout(timer);
      resolve();
    }
    this.debounceState.clear();

    // Clear any remaining timeout timers
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
  }
}
