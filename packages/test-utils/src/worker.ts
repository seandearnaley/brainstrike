import { vi } from 'vitest';

/**
 * Installs a lightweight mock for global Worker, returning a teardown function.
 * Use in tests that interact with Web Workers instead of a global override.
 */
export function installMockWorkers(options?: { maxWorkers?: number }) {
  const maxWorkers = options?.maxWorkers ?? 10;
  const createdWorkers: Set<Worker> = new Set();
  const workerString = 'Worker';
  const OriginalWindowWorker =
    typeof window === 'undefined'
      ? undefined
      : ((window as unknown as { [k: string]: unknown })[workerString] as
          | typeof Worker
          | undefined);

  const OriginalGlobalWorker = (globalThis as { [k: string]: unknown })[workerString] as
    | typeof Worker
    | undefined;

  class MockWorker {
    onmessage: ((this: Worker, ev: MessageEvent) => void) | null = null;
    onerror: ((this: AbstractWorker, ev: ErrorEvent) => void) | null = null;
    onmessageerror: ((this: Worker, ev: MessageEvent) => void) | null = null;
    // biome-ignore lint/style/useReadonlyClassProperties: Mutable property - set in terminate() method
    private _terminated = false;

    postMessage = vi.fn();
    terminate = vi.fn(() => {
      this._terminated = true;
      createdWorkers.delete(this);
    });
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn();

    constructor(_url: string | URL, _options?: WorkerOptions) {
      if (createdWorkers.size >= maxWorkers) {
        throw new Error(`Too many workers created (${maxWorkers}). Possible worker leak in tests.`);
      }
      createdWorkers.add(this);
      queueMicrotask(() => {
        if (!this._terminated && this.onmessage) {
          this.onmessage(new MessageEvent('message', { data: { type: 'ready' } }));
        }
      });
    }
  }

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: MockWorker,
    });
  }
  Object.defineProperty(global, 'Worker', {
    configurable: true,
    writable: true,
    value: MockWorker,
  });

  const teardown = () => {
    createdWorkers.forEach((w) => {
      w.terminate();
    });
    createdWorkers.clear();
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: OriginalWindowWorker,
      });
    }
    Object.defineProperty(globalThis as object, 'Worker', {
      configurable: true,
      writable: true,
      value: OriginalGlobalWorker,
    });
  };

  return { teardown } as const;
}
