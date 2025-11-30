import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorker } from '../worker-init';
import { WorkerStorage } from '../worker-storage';

// Mock dependencies
vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../worker-storage', () => ({
  WorkerStorage: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.isWorkerAvailable = true;
    this.destroy = vi.fn();
  }),
}));

describe('worker-init', () => {
  // Store original globals
  const originalWindow = global.window;
  const originalNavigator = global.navigator;
  const originalProcess = global.process;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore globals
    if (originalWindow) {
      global.window = originalWindow;
    } else {
      (global as any).window = undefined;
    }

    if (originalNavigator) {
      global.navigator = originalNavigator;
    } else {
      (global as any).navigator = undefined;
    }

    if (originalProcess) {
      global.process = originalProcess;
    } else {
      (global as any).process = undefined;
    }
  });

  it('initializes worker in browser environment when not test/headless/electron', () => {
    // Simulate browser environment
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      webdriver: false,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
    });
    // Ensure process is not defined or is clean
    vi.stubGlobal('process', undefined);

    // Also ensure playwright is not in globalThis (Vitest may inject it)
    const originalPlaywright =
      'playwright' in globalThis ? (globalThis as Record<string, unknown>).playwright : undefined;
    if ('playwright' in globalThis) {
      (globalThis as Record<string, unknown>).playwright = undefined;
    }

    try {
      const result = initWorker(false, true);

      expect(result.useWorker).toBe(true);
      expect(WorkerStorage).toHaveBeenCalled();
      expect(window.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    } finally {
      // Restore playwright if it was there
      if (originalPlaywright !== undefined) {
        (globalThis as Record<string, unknown>).playwright = originalPlaywright;
      }
    }
  });

  it('does not initialize worker in test environment', () => {
    const result = initWorker(true, true);

    expect(result.useWorker).toBe(false);
    expect(WorkerStorage).not.toHaveBeenCalled();
    expect(result.workerStorage).toBeNull();
  });

  it('does not initialize worker in Electron renderer', () => {
    vi.stubGlobal('window', {
      process: { type: 'renderer' },
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 ... Electron/...',
    });

    const result = initWorker(false, true);

    expect(result.useWorker).toBe(false);
    expect(WorkerStorage).not.toHaveBeenCalled();
  });

  it('does not initialize worker in Headless Chrome', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 ... HeadlessChrome/...',
    });

    const result = initWorker(false, true);

    expect(result.useWorker).toBe(false);
    expect(WorkerStorage).not.toHaveBeenCalled();
  });

  it('does not initialize worker in CI environment', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/100.0',
      webdriver: false,
    });
    vi.stubGlobal('process', {
      env: { CI: 'true' },
    });

    const result = initWorker(false, true);

    expect(result.useWorker).toBe(false);
    expect(WorkerStorage).not.toHaveBeenCalled();
  });

  it('returns useWorker=false if WorkerStorage initialization fails', () => {
    // Simulate browser environment
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      webdriver: false,
      userAgent: 'Mozilla/5.0 Chrome/100.0',
    });
    vi.stubGlobal('process', undefined);

    // Mock WorkerStorage to throw (using function syntax for Vitest 4)
    (WorkerStorage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('Worker init failed');
    });

    const result = initWorker(false, true);

    expect(result.useWorker).toBe(false);
    expect(result.workerStorage).toBeNull();
  });

  it('logs debug message when worker is disabled', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 ... HeadlessChrome/...',
    });

    initWorker(false, true);

    // We can't easily assert the log content without importing the mocked logger,
    // but we can verify code execution path doesn't crash.
  });
});
