/**
 * Worker-based Storage Adapter
 *
 * Provides a storage interface that offloads serialization and I/O operations
 * to a Web Worker to prevent UI blocking during large state saves.
 */

import { createLogger } from '@brainstrike/utils';

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
  return new URL('./persistence/worker-storage.worker.mjs', import.meta.url);
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
    }
  >();

  /**
   * Create a WorkerStorage instance.
   * @param workerUrl - Pre-resolved worker URL from `resolveWorkerStorageUrl()`.
   *   This parameter is required to ensure Vite can statically analyze the worker URL
   *   at the call site. Call `resolveWorkerStorageUrl()` before constructing.
   *
   * @example
   * ```ts
   * const workerUrl = resolveWorkerStorageUrl();
   * const storage = new WorkerStorage(workerUrl);
   * ```
   */
  constructor(workerUrl: URL) {
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
          this.processSetItemRequest(id, key, value, opId);
          break;
        case 'getItem':
          this.processGetItemRequest(id, key);
          break;
        case 'removeItem':
          this.processRemoveItemRequest(id, key);
          break;
        default:
          break;
      }
    } catch (error) {
      this.worker?.postMessage({
        id,
        type: 'storage_response',
        operation,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private processSetItemRequest(id: string, key: string, value: string | undefined, opId?: number) {
    const lastOp = this.activeSaveOps.get(key) ?? 0;
    if (opId && opId < lastOp) {
      this.worker?.postMessage({
        id,
        type: 'storage_response',
        operation: 'setItem',
        success: true,
      });
      return;
    }
    if (opId) {
      this.activeSaveOps.set(key, opId);
    }

    // If value is undefined, we still need to respond but shouldn't store anything
    if (value === undefined) {
      this.worker?.postMessage({
        id,
        type: 'storage_response',
        operation: 'setItem',
        success: false,
        error: 'Cannot store undefined value',
      });
      return;
    }

    try {
      localStorage.setItem(key, value);
    } catch (e) {
      logger.warn('localStorage setItem failed:', e);
    }
    this.worker?.postMessage({ id, type: 'storage_response', operation: 'setItem', success: true });
  }

  private processGetItemRequest(id: string, key: string) {
    let rawValue: string | null = null;
    try {
      rawValue = localStorage.getItem(key);
    } catch (e) {
      logger.warn('localStorage getItem failed:', e);
    }
    this.worker?.postMessage({ id, type: 'storage_response', operation: 'getItem', rawValue });
  }

  private processRemoveItemRequest(id: string, key: string) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      logger.warn('localStorage removeItem failed:', e);
    }
    this.worker?.postMessage({
      id,
      type: 'storage_response',
      operation: 'removeItem',
      success: true,
    });
  }

  private handleWorkerError(error: ErrorEvent) {
    logger.error('Worker error occurred:', error.error || error.message);

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
      this.pendingRequests.set(id, { resolve, reject });

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
      // Fallback to direct localStorage access
      const rawValue = localStorage.getItem(key);
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
          resolve();
        } catch (error) {
          logger.error('Worker setItem failed:', error);
          // Fallback path, ensure we store stringified value
          const serialized = typeof value === 'string' ? value : JSON.stringify(value);
          try {
            localStorage.setItem(key, serialized);
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      }, 100); // 100ms debounce

      this.debounceState.set(key, { timer, resolve });
    });
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.sendMessage('remove', key);
    } catch (error) {
      logger.error('Worker removeItem failed:', error);
      // Fallback to direct localStorage access
      localStorage.removeItem(key);
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
