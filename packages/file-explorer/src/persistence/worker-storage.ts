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
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private activeSaveOps = new Map<string, number>();

  constructor() {
    this.initializeWorker();
  }

  private async initializeWorker() {
    if (typeof Worker === 'undefined') {
      // Web Workers not supported
      return;
    }

    try {
      // Check if we're in a supported environment (not Electron)
      const isElectron =
        typeof window !== 'undefined' &&
        (window as { process?: { type?: string } }).process?.type === 'renderer';

      if (!isElectron && typeof import.meta.url !== 'undefined') {
        // Use inline worker for better compatibility
        // Worker handles JSON serialization/deserialization but delegates storage to main thread
        const workerCode = `
          self.addEventListener('message', async (event) => {
            const { id, type, key, value } = event.data;
            try {
              let result;
              switch (type) {
                case 'save': {
                  if (!key || value === undefined) {
                    throw new Error('Save operation requires key and value');
                  }
                  // Perform heavy JSON serialization in worker
                  const serialized = JSON.stringify(value);
                  const opId = Date.now();
                  // Send serialized data back to main thread for storage
                  self.postMessage({ 
                    id, 
                    type: 'storage_request', 
                    operation: 'setItem',
                    key: key,
                    value: serialized,
                    opId: opId
                  });
                  return; // Don't send success yet, wait for main thread response
                }
                case 'load': {
                  if (!key) {
                    throw new Error('Load operation requires key');
                  }
                  // Request data from main thread
                  self.postMessage({ 
                    id, 
                    type: 'storage_request', 
                    operation: 'getItem',
                    key: key
                  });
                  return; // Don't send success yet, wait for main thread response
                }
                case 'remove': {
                  if (!key) {
                    throw new Error('Remove operation requires key');
                  }
                  // Request removal from main thread
                  self.postMessage({ 
                    id, 
                    type: 'storage_request', 
                    operation: 'removeItem',
                    key: key
                  });
                  return; // Don't send success yet, wait for main thread response
                }
                case 'storage_response': {
                  // Handle response from main thread storage operation
                  if (event.data.operation === 'getItem' && event.data.rawValue) {
                    // Perform heavy JSON parsing in worker
                    result = JSON.parse(event.data.rawValue);
                  } else {
                    result = event.data.success || true;
                  }
                  self.postMessage({ id, type: 'success', result });
                  break;
                }
                default:
                  throw new Error(\`Unknown operation type: \${type}\`);
              }
            } catch (error) {
              self.postMessage({ 
                id, 
                type: 'error', 
                error: error instanceof Error ? error.message : 'Unknown error' 
              });
            }
          });
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);

        this.worker = new Worker(workerUrl);
        this.worker.addEventListener('message', this.handleWorkerMessage.bind(this));
        this.worker.addEventListener('error', this.handleWorkerError.bind(this));

        // Clean up the blob URL
        URL.revokeObjectURL(workerUrl);
      }
    } catch (error) {
      console.warn('Failed to initialize Web Worker for state persistence:', error);
      this.worker = null;
    }
  }

  private handleWorkerMessage(event: MessageEvent<WorkerResponse | StorageRequest>) {
    const { id, type } = event.data;

    // Handle storage requests from worker
    if (type === 'storage_request') {
      this.handleStorageRequest(event.data as StorageRequest);
      return;
    }

    // Handle normal worker responses
    const workerResponse = event.data as WorkerResponse;
    const { result, error } = workerResponse;
    const request = this.pendingRequests.get(id);

    if (!request) {
      console.warn('Received worker response for unknown request:', id);
      return;
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
        case 'setItem': {
          if (value !== undefined) {
            // Race condition mitigation: only save if this is the newest operation
            const lastOp = this.activeSaveOps.get(key) ?? 0;
            if (opId && opId < lastOp) {
              // A newer save operation has already started, so we discard this one.
              this.worker?.postMessage({ id, type: 'storage_response', operation, success: true });
              return;
            }
            if (opId) {
              this.activeSaveOps.set(key, opId);
            }
            // Swallow quota exceptions
            try {
              localStorage.setItem(key, value);
            } catch (e) {
              console.warn(`Failed to setItem in localStorage for key "${key}":`, e);
            }
          }
          this.worker?.postMessage({
            id,
            type: 'storage_response',
            operation,
            success: true,
          } as StorageResponse);
          break;
        }
        case 'getItem': {
          let rawValue = null;
          try {
            rawValue = localStorage.getItem(key);
          } catch (e) {
            console.warn(`Failed to getItem from localStorage for key "${key}":`, e);
          }
          this.worker?.postMessage({
            id,
            type: 'storage_response',
            operation,
            rawValue,
          } as StorageResponse);
          break;
        }
        case 'removeItem': {
          try {
            localStorage.removeItem(key);
          } catch (e) {
            console.warn(`Failed to removeItem from localStorage for key "${key}":`, e);
          }
          this.worker?.postMessage({
            id,
            type: 'storage_response',
            operation,
            success: true,
          } as StorageResponse);
          break;
        }
        default:
          // Should be unreachable
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
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Worker request timeout'));
        }
      }, 30000); // 30 second timeout - increased to account for concurrent file operations
    });
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const result = await this.sendMessage('load', key);
      return result as string | null;
    } catch (error) {
      console.error('Worker getItem failed:', error);
      // Fallback to direct localStorage access
      return localStorage.getItem(key);
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await this.sendMessage('save', key, value);
    } catch (error) {
      console.error('Worker setItem failed:', error);
      // Fallback to direct localStorage access
      localStorage.setItem(key, value);
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
