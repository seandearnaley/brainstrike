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

export class WorkerStorage {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

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
                  const serialized = JSON.stringify(value);
                  localStorage.setItem(key, serialized);
                  result = true;
                  break;
                }
                case 'load': {
                  if (!key) {
                    throw new Error('Load operation requires key');
                  }
                  const storedValue = localStorage.getItem(key);
                  result = storedValue ? JSON.parse(storedValue) : null;
                  break;
                }
                case 'remove': {
                  if (!key) {
                    throw new Error('Remove operation requires key');
                  }
                  localStorage.removeItem(key);
                  result = true;
                  break;
                }
                default:
                  throw new Error(\`Unknown operation type: \${type}\`);
              }
              self.postMessage({ id, type: 'success', result });
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

  private handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
    const { id, type, result, error } = event.data;
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
      }, 10000); // 10 second timeout
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
