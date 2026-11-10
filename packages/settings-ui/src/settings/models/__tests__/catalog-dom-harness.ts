import { vi } from 'vitest';
import type { CatalogRowActions } from '../use-catalog-row-actions';

const MOCK_ROW_PITCH = 36;

/**
 * jsdom has no layout, so the real virtualizer renders nothing. This stand-in
 * renders every row (same approach as the log viewer's harness); the real
 * windowing is proven in the web E2E (Task 10).
 */
export function createMockCatalogVirtualizer({ count }: { readonly count: number }) {
  return {
    getTotalSize: () => count * MOCK_ROW_PITCH,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * MOCK_ROW_PITCH,
        index,
        key: index,
        lane: 0,
        size: MOCK_ROW_PITCH,
        start: index * MOCK_ROW_PITCH,
      })),
    measure: () => undefined,
    measureElement: () => undefined,
    measurementsCache: [],
    scrollToIndex: () => undefined,
    scrollToOffset: () => undefined,
  };
}

function reportWidth(
  callback: ResizeObserverCallback,
  observer: ResizeObserver,
  target: Element,
  width: number
): void {
  const entry = {
    borderBoxSize: [],
    contentBoxSize: [],
    contentRect: { bottom: 600, height: 600, left: 0, right: width, top: 0, width, x: 0, y: 0 },
    devicePixelContentBoxSize: [],
    target,
  } as unknown as ResizeObserverEntry;
  callback([entry], observer);
}

export interface CatalogDomStubs {
  /** Reports a new content width to every observed element, as a window resize would. */
  readonly resize: (width: number) => void;
}

/**
 * ResizeObserver stub. With a `width`, every observed element immediately
 * reports that content width — this is how tests mock the catalog container
 * width (design §11: "container width mocked"). With `null` it never reports.
 */
export function installCatalogDomStubs({
  width,
}: {
  readonly width: number | null;
}): CatalogDomStubs {
  const observed: {
    callback: ResizeObserverCallback;
    observer: ResizeObserver;
    target: Element;
  }[] = [];

  class StubResizeObserver {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    disconnect(): void {
      // nothing is really observed
    }

    observe(target: Element): void {
      const observer = this as unknown as ResizeObserver;
      observed.push({ callback: this.callback, observer, target });
      if (width !== null) {
        reportWidth(this.callback, observer, target, width);
      }
    }

    unobserve(): void {
      // nothing is really observed
    }
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  return {
    resize: (next) => {
      for (const { callback, observer, target } of observed) {
        reportWidth(callback, observer, target, next);
      }
    },
  };
}

export function makeRowActions(overrides: Partial<CatalogRowActions> = {}): CatalogRowActions {
  return {
    busyModelIds: new Set<string>(),
    onToggle: vi.fn(),
    onToggleDetails: vi.fn(),
    query: '',
    ...overrides,
  };
}
