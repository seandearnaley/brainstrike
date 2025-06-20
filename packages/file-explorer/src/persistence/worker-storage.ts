/**
 * Worker-based Storage Adapter
 *
 * Provides a storage interface that offloads serialization and I/O operations
 * to a Web Worker to prevent UI blocking during large state saves.
 */

export interface WorkerMessage {
  id: string;
  type: 'save' | 'load' | 'remove';
  key?: string | undefined;
  value?: unknown;
}

export interface WorkerResponse {
  id: string;
  type: 'success' | 'error';
  result?: unknown;
  error?: string;
}

export interface StorageRequest {
  id: string;
  type: 'storage_request';
  operation: 'setItem' | 'getItem' | 'removeItem';
  key: string;
  value?: string;
  opId?: number;
}

export interface StorageResponse {
  id: string;
  type: 'storage_response';
  operation: 'setItem' | 'getItem' | 'removeItem';
  success?: boolean;
  rawValue?: string | null;
}

export class WorkerStorage {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private activeSaveOps = new Map<string, number>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.initializeWorker();
  }

  private initializeWorker() {
    if (typeof Worker === 'undefined') {
      // Web Workers not supported
      return;
    }

    try {
      if (typeof import.meta.url !== 'undefined') {
        const workerUrl = new URL('./worker-storage.worker.js', import.meta.url);
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.registerWorkerListeners();
      }
    } catch (error) {
      console.warn('Failed to initialize Web Worker for state persistence:', error);
      this.worker = null;
    }
  }

  private registerWorkerListeners() {
    if (!this.worker) return;

    this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
    this.worker.addEventListener('error', this.handleWorkerError.bind(this));
  }

  private handleWorkerMessage(event: MessageEvent<WorkerResponse | StorageRequest>) {
    const { type } = event.data;

    if (type === 'storage_request') {
      this.handleStorageRequest(event.data as StorageRequest);
    } else {
      this.handleWorkerResponse(event.data as WorkerResponse);
    }
  }

  private handleWorkerResponse({ id, type, result, error }: WorkerResponse) {
    const request = this.pendingRequests.get(id);

    if (!request) {
      console.warn('Received worker response for unknown request:', id);
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
      console.warn(`Failed to setItem in localStorage for key "${key}":`, e);
    }
    this.worker?.postMessage({ id, type: 'storage_response', operation: 'setItem', success: true });
  }

  private processGetItemRequest(id: string, key: string) {
    let rawValue: string | null = null;
    try {
      rawValue = localStorage.getItem(key);
    } catch (e) {
      console.warn(`Failed to getItem from localStorage for key "${key}":`, e);
    }
    this.worker?.postMessage({ id, type: 'storage_response', operation: 'getItem', rawValue });
  }

  private processRemoveItemRequest(id: string, key: string) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`Failed to removeItem from localStorage for key "${key}":`, e);
    }
    this.worker?.postMessage({
      id,
      type: 'storage_response',
      operation: 'removeItem',
      success: true,
    });
  }

  private handleWorkerError(error: ErrorEvent) {
    console.error('Worker error:', error);
    // Reject all pending requests
    for (const [, request] of this.pendingRequests) {
      request.reject(new Error('Worker error occurred'));
    }
    this.pendingRequests.clear();
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
      }, 30000); // 30 s timeout – long enough for massive saves but short enough to fail fast

      this.timeouts.set(id, timeout);
    });
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    try {
      const result = await this.sendMessage('load', key);
      return result as T | null;
    } catch (error) {
      console.error('Worker getItem failed:', error);
      // Fallback to direct localStorage access
      const rawValue = localStorage.getItem(key);
      if (!rawValue) return null;

      try {
        return JSON.parse(rawValue) as T;
      } catch {
        // If parsing fails, return the raw value as-is (for backward compatibility)
        return rawValue as T;
      }
    }
  }

  async setItem(key: string, value: unknown): Promise<void> {
    const payload = typeof value === 'string' ? value : value;
    try {
      await this.sendMessage('save', key, payload);
    } catch (error) {
      console.error('Worker setItem failed:', error);
      // For fallback path, ensure we store stringified value
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      try {
        localStorage.setItem(key, serialized);
      } catch (e) {
        console.warn(`Failed to setItem in localStorage for key "${key}":`, e);
      }
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.sendMessage('remove', key);
    } catch (error) {
      console.error('Worker removeItem failed:', error);
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
  }
}
