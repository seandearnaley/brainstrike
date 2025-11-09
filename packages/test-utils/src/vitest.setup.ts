import '@testing-library/jest-dom';
import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetStore } from './test-utils';

// Configure React's act() environment for Zustand store updates
// This prevents false-positive act(...) warnings when Zustand triggers re-renders
// See: https://github.com/pmndrs/zustand/issues/2200
if (typeof globalThis !== 'undefined') {
  // @ts-expect-error - IS_REACT_ACT_ENVIRONMENT is a React internal flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

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

if (!(Buffer.prototype as unknown as { arrayBuffer?: () => ArrayBuffer }).arrayBuffer) {
  Object.defineProperty(Buffer.prototype, 'arrayBuffer', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(this: Buffer) {
      const { buffer, byteOffset, byteLength } = this;
      return buffer.slice(byteOffset, byteOffset + byteLength);
    },
  });
}

if (typeof Blob === 'undefined' || typeof Blob.prototype.arrayBuffer !== 'function') {
  // @ts-expect-error - assign Node Blob polyfill for tests
  globalThis.Blob = NodeBlob;
}

const nativeFetch = globalThis.fetch?.bind(globalThis);
if (nativeFetch) {
  globalThis.fetch = async (input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === 'object' && input && 'url' in input
            ? String((input as { url?: string }).url)
            : String(input);

    if (url.startsWith('file:')) {
      const data = await readFile(new URL(url));
      const arrayBuffer = Uint8Array.from(data).buffer;
      return new Response(arrayBuffer);
    }

    let normalizedInput: RequestInfo | URL;
    if (typeof input === 'string' || input instanceof URL) {
      normalizedInput = input;
    } else if (typeof input === 'object' && input !== null && 'url' in input) {
      normalizedInput = input as RequestInfo;
    } else {
      normalizedInput = String(input);
    }

    const normalizedInit = init as RequestInit | undefined;
    return nativeFetch(normalizedInput, normalizedInit);
  };
}
