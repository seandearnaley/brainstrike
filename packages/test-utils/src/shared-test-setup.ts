import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetStore } from './test-utils.js';

/**
 * Hooks, globals and polyfills shared by `vitest.setup.ts` and
 * `vitest.dom-aware.setup.ts`. Everything here works in any environment; the
 * DOM-only mocks below stay behind their own `typeof window` check.
 *
 * @param domCleanup React Testing Library's `cleanup`, or `undefined` when the
 *   environment has no DOM and the library was not loaded.
 */
export function installSharedTestSetup(domCleanup: (() => void) | undefined): void {
  // Configure React's act() environment for Zustand store updates
  // Keep React's warnings observable: tests must wrap state updates instead of
  // mutating console.error to hide failures in synchronization.
  // See: https://github.com/pmndrs/zustand/issues/2200
  if (typeof globalThis !== 'undefined') {
    // @ts-expect-error - IS_REACT_ACT_ENVIRONMENT is a React internal flag
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  }

  // Reset store state for each test to ensure isolation
  beforeEach(() => {
    resetStore();
  });

  // Global safety: always restore real timers and cleanup React between tests
  afterEach(() => {
    vi.useRealTimers();
    domCleanup?.();
  });

  // Keep minimal DOM polyfills that are common across UI tests.

  if (typeof window !== 'undefined') {
    // Mock window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockImplementation((query) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      writable: true,
    });

    // Mock IntersectionObserver
    class MockIntersectionObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn().mockReturnValue([]);
    }

    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: MockIntersectionObserver,
      writable: true,
    });

    // Mock ResizeObserver
    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: MockResizeObserver,
      writable: true,
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
      value(this: Buffer) {
        const { buffer, byteOffset, byteLength } = this;
        return buffer.slice(byteOffset, byteOffset + byteLength);
      },
      writable: true,
    });
  }

  if (typeof Blob === 'undefined' || typeof Blob.prototype.arrayBuffer !== 'function') {
    // @ts-expect-error - assign Node Blob polyfill for tests
    globalThis.Blob = NodeBlob;
  }

  const nativeFetch = globalThis.fetch?.bind(globalThis);
  if (nativeFetch) {
    globalThis.fetch = createFileUrlFetch(nativeFetch);
  }
}

/** `fetch` that serves `file:` URLs from disk and forwards everything else. */
function createFileUrlFetch(nativeFetch: typeof fetch): typeof fetch {
  return async (input: unknown, init?: unknown) => {
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
