import '@testing-library/jest-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetStore } from './test-utils';

// Reset store state for each test to ensure isolation
beforeEach(() => {
  resetStore();
});

// Global safety: always restore real timers between tests
afterEach(() => {
  vi.useRealTimers();
});

// The import '@testing-library/jest-dom' at the top should handle extending expect.
// Keep minimal DOM polyfills that are common across UI tests.

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
}

// Mock TextDecoder/TextEncoder only if missing (Node 22+ provides them, but be defensive)
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

if (typeof global.TextDecoder === 'undefined') {
  global.TextDecoder = MockTextDecoder as unknown as typeof global.TextDecoder;
}
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = MockTextEncoder as unknown as typeof global.TextEncoder;
}
