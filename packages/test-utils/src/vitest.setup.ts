import '@testing-library/jest-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetStore } from './test-utils';

// Configure React 19 test environment

// Track all created mock workers for cleanup
const createdWorkers: Set<Worker> = new Set();
const MAX_WORKERS = 10; // Prevent runaway worker creation

// Reset store before each test
beforeEach(() => {
  resetStore();
  // Clear any workers from previous tests
  createdWorkers.clear();
});

// Clean up after each test
afterEach(() => {
  // Terminate any mock workers that were created
  createdWorkers.forEach((worker) => {
    if (worker && typeof worker.terminate === 'function') {
      worker.terminate();
    }
  });
  createdWorkers.clear();
});

// The import '@testing-library/jest-dom' at the top should handle extending expect.
// The custom expect.extend for toBeInTheDocument has been removed as it's redundant
// and potentially conflicting.

if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock IntersectionObserver
  class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn().mockReturnValue([]);
  }

  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    configurable: true,
    value: MockIntersectionObserver,
  });

  // Mock ResizeObserver
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: MockResizeObserver,
  });

  // Mock Worker - prevent real Workers from being created in tests
  class MockWorker {
    onmessage: ((this: Worker, ev: MessageEvent) => void) | null = null;
    onerror: ((this: AbstractWorker, ev: ErrorEvent) => void) | null = null;
    onmessageerror: ((this: Worker, ev: MessageEvent) => void) | null = null;
    private _terminated = false;

    postMessage = vi.fn();
    terminate = vi.fn(() => {
      this._terminated = true;
      createdWorkers.delete(this);
    });
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn();

    constructor(url: string | URL, options?: WorkerOptions) {
      void url;
      void options;

      // Prevent too many workers from being created
      if (createdWorkers.size >= MAX_WORKERS) {
        throw new Error(
          `Too many workers created (${MAX_WORKERS}). Possible worker leak in tests.`
        );
      }

      // Track this worker instance
      createdWorkers.add(this);

      // Don't simulate messages if already terminated
      setTimeout(() => {
        if (!this._terminated && this.onmessage) {
          this.onmessage(new MessageEvent('message', { data: { type: 'ready' } }));
        }
      }, 0);
    }
  }

  Object.defineProperty(window, 'Worker', {
    writable: true,
    configurable: true,
    value: MockWorker,
  });

  // Also set it on global for Node.js environments
  Object.defineProperty(global, 'Worker', {
    writable: true,
    configurable: true,
    value: MockWorker,
  });
}

// Mock TextDecoder/TextEncoder
// This addresses the type compatibility issue with TextDecoder
class MockTextDecoder {
  decode(input?: ArrayBuffer | ArrayBufferView | null, options?: { stream?: boolean }): string {
    void input;
    void options;
    return '';
  }
}

class MockTextEncoder {
  encode(input?: string): Uint8Array {
    void input;
    return new Uint8Array();
  }
}

// Use type assertion to avoid type compatibility issues
if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = MockTextDecoder as unknown as typeof global.TextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = MockTextEncoder as unknown as typeof global.TextEncoder;
}

// Configure console to handle test output better
const originalError = console.error;
console.error = (...args) => {
  // List of expected error messages to filter
  const expectedErrors = [
    'Not implemented: window.computedStyle',
    'The current testing environment is not configured to support act',
    'inside a test was not wrapped in act',
    'Error: Access denied', // File access errors in tests
    'Error processing fail', // Expected file processing errors
    'PartialRefreshError', // Expected partial refresh errors
    'Error loading file tree', // Expected file tree loading errors
    'Error getting file handle', // Expected file handle errors
    'Failed to load file', // Expected file loading errors
    'Failed to refresh file tree', // Expected file tree refresh errors
  ];

  // Check if any of the arguments contain expected error messages
  if (
    args.some((arg) => {
      const str = arg?.toString() || '';
      return (
        expectedErrors.some((expected) => str.includes(expected)) ||
        arg?.stack?.includes('Not implemented: window.computedStyle')
      );
    })
  ) {
    return;
  }

  // Ignore specific React errors in tests
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('Warning: ReactDOM.render is no longer supported') ||
      args[0].includes('Warning: React.createFactory()') ||
      args[0].includes('Warning: Using UNSAFE_') ||
      args[0].includes('Warning: findDOMNode'))
  ) {
    return;
  }
  originalError(...args);
};
