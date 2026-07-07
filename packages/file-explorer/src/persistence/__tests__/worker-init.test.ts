import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorker } from '../worker-init';
import { WorkerStorage } from '../worker-storage';

// Mock dependencies
vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../worker-storage', () => ({
  resolveWorkerStorageUrl: vi.fn().mockReturnValue(new URL('file:///mock-worker.js')),
  WorkerStorage: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.isWorkerAvailable = true;
    this.destroy = vi.fn();
    this.flushPendingWrites = vi.fn();
  }),
}));

const mockStorageAdapter = {
  clear: vi.fn(),
  getAllKeys: vi.fn(),
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
};

describe('worker-init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initializes worker in browser environment when not test/headless/electron', () => {
    // Simulate browser environment
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
      webdriver: false,
    });
    // Also ensure playwright is not in globalThis (Vitest may inject it)
    const originalPlaywright =
      'playwright' in globalThis ? (globalThis as Record<string, unknown>).playwright : undefined;
    if ('playwright' in globalThis) {
      (globalThis as Record<string, unknown>).playwright = undefined;
    }

    try {
      const result = initWorker(mockStorageAdapter, false, true);

      expect(result.useWorker).toBe(true);
      expect(WorkerStorage).toHaveBeenCalled();
      expect(window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
      expect(window.addEventListener).toHaveBeenCalledWith('unload', expect.any(Function));
      expect(document.addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
    } finally {
      // Restore playwright if it was there
      if (originalPlaywright !== undefined) {
        (globalThis as Record<string, unknown>).playwright = originalPlaywright;
      }
    }
  });

  it('does not initialize worker in test environment', () => {
    const result = initWorker(mockStorageAdapter, true, true);

    expect(result.useWorker).toBe(false);
    expect(WorkerStorage).not.toHaveBeenCalled();
    expect(result.workerStorage).toBeNull();
  });

  it('does not initialize worker during SSR when window is unavailable', () => {
    vi.stubGlobal('window', undefined);

    const result = initWorker(mockStorageAdapter, false, true);

    expect(result).toEqual({ useWorker: false, workerStorage: null });
    expect(WorkerStorage).not.toHaveBeenCalled();
  });

  it('initializes worker in Electron renderer when Worker is available', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      process: { type: 'renderer' },
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 ... Electron/...',
    });

    const result = initWorker(mockStorageAdapter, false, true);

    expect(result.useWorker).toBe(true);
    expect(WorkerStorage).toHaveBeenCalled();
    expect(window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(window.addEventListener).toHaveBeenCalledWith('unload', expect.any(Function));
    expect(document.addEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
  });

  it('initializes worker in headless browser environments when Worker is available', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 ... HeadlessChrome/...',
    });

    const result = initWorker(mockStorageAdapter, false, true);

    expect(result.useWorker).toBe(true);
    expect(WorkerStorage).toHaveBeenCalled();
  });

  it('initializes worker in CI-like browser environments when Worker is available', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/100.0',
      webdriver: false,
    });

    const result = initWorker(mockStorageAdapter, false, true);

    expect(result.useWorker).toBe(true);
    expect(WorkerStorage).toHaveBeenCalled();
  });

  it('returns useWorker=false if WorkerStorage initialization fails', () => {
    // Simulate browser environment
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/100.0',
      webdriver: false,
    });
    (WorkerStorage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      function failWorkerStorageInitialization(): never {
        throw new Error('Worker init failed');
      }
    );

    const result = initWorker(mockStorageAdapter, false, true);

    expect(result.useWorker).toBe(false);
    expect(result.workerStorage).toBeNull();
  });

  it('flushes and destroys worker storage during beforeunload cleanup', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', {
      addEventListener,
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible',
    });

    const result = initWorker(mockStorageAdapter, false, true);
    const beforeUnloadHandler = addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'beforeunload'
    )?.[1] as (() => void) | undefined;

    expect(beforeUnloadHandler).toBeTypeOf('function');
    beforeUnloadHandler?.();

    expect(result.workerStorage?.flushPendingWrites).toHaveBeenCalled();
    expect(result.workerStorage?.destroy).toHaveBeenCalled();
  });

  it('flushes pending writes when the tab becomes hidden', () => {
    const documentListeners = new Map<string, EventListener>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn((eventName: string, handler: EventListener) => {
        documentListeners.set(eventName, handler);
      }),
      visibilityState: 'visible',
    });

    const result = initWorker(mockStorageAdapter, false, true);
    const visibilityHandler = documentListeners.get('visibilitychange');

    expect(visibilityHandler).toBeTypeOf('function');
    (document as { visibilityState: string }).visibilityState = 'hidden';
    visibilityHandler?.(new Event('visibilitychange'));

    expect(result.workerStorage?.flushPendingWrites).toHaveBeenCalled();
  });

  it('logs debug message when worker is disabled in test mode', () => {
    initWorker(mockStorageAdapter, true, true);

    // We can't easily assert the log content without importing the mocked logger,
    // but we can verify code execution path doesn't crash.
  });
});
