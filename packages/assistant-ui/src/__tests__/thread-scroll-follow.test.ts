import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createThreadScrollFollow } from '../thread-scroll-follow';

let mutationCallback: MutationCallback | null = null;
let nextFrameId = 1;
let frameCallbacks = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  mutationCallback = null;
  nextFrameId = 1;
  frameCallbacks = new Map();

  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    }
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }

      disconnect(): void {}
      observe(): void {}
      takeRecords(): MutationRecord[] {
        return [];
      }
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    frameCallbacks.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (frameId: number): void => {
    frameCallbacks.delete(frameId);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flushAnimationFrames = (): void => {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) {
    callback(performance.now());
  }
};

describe('createThreadScrollFollow', () => {
  test('measures mutation-driven growth after layout settles', () => {
    let scrollHeight = 100;
    const clientHeight = 100;
    let scrollTop = 0;
    const element = document.createElement('div');
    Object.defineProperties(element, {
      clientHeight: { get: () => clientHeight },
      scrollHeight: { get: () => scrollHeight },
      scrollTop: {
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = next;
        },
      },
    });
    const scrollTo = vi.fn((options: ScrollToOptions | number, y?: number): void => {
      scrollTop = typeof options === 'number' ? (y ?? scrollTop) : (options.top ?? scrollTop);
    });
    Object.defineProperty(element, 'scrollTo', { value: scrollTo });

    const follow = createThreadScrollFollow();
    const detach = follow.attach(element);
    const callback = mutationCallback;
    if (!callback) {
      throw new Error('Thread scroll follow did not attach its mutation observer.');
    }

    callback(
      [{ attributeName: null, type: 'childList' } as unknown as MutationRecord],
      {} as unknown as MutationObserver
    );
    callback(
      [{ attributeName: null, type: 'characterData' } as unknown as MutationRecord],
      {} as unknown as MutationObserver
    );
    expect(frameCallbacks.size).toBe(1);
    scrollHeight = 200;
    flushAnimationFrames();

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'instant', top: 200 });
    expect(scrollTop).toBe(200);

    callback(
      [{ attributeName: null, type: 'characterData' } as unknown as MutationRecord],
      {} as unknown as MutationObserver
    );
    expect(frameCallbacks.size).toBe(1);
    element.dispatchEvent(new Event('pointerdown'));
    expect(frameCallbacks.size).toBe(0);
    detach();
  });
});
