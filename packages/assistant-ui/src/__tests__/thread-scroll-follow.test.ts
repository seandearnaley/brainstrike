import { renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ThreadScrollFollowProvider, useThreadScrollFollow } from '../thread-scroll-follow';

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

const FollowProvider = ({ children }: PropsWithChildren) =>
  createElement(ThreadScrollFollowProvider, null, children);

describe('ThreadScrollFollowProvider', () => {
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
          scrollTop = Math.max(0, Math.min(next, scrollHeight - clientHeight));
        },
      },
    });
    const scrollTo = vi.fn((options: ScrollToOptions | number, y?: number): void => {
      element.scrollTop =
        typeof options === 'number' ? (y ?? element.scrollTop) : (options.top ?? element.scrollTop);
    });
    Object.defineProperty(element, 'scrollTo', { value: scrollTo });

    const { result, unmount } = renderHook(useThreadScrollFollow, {
      wrapper: FollowProvider,
    });
    const follow = result.current;
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

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'instant', top: 200 });
    expect(scrollTop).toBe(100);

    for (const eventType of ['pointerdown', 'touchstart', 'wheel']) {
      callback(
        [{ attributeName: null, type: 'characterData' } as unknown as MutationRecord],
        {} as unknown as MutationObserver
      );
      expect(frameCallbacks.size).toBe(1);
      element.dispatchEvent(new Event(eventType));
      expect(frameCallbacks.size).toBe(0);
    }

    callback(
      [{ attributeName: null, type: 'characterData' } as unknown as MutationRecord],
      {} as unknown as MutationObserver
    );
    expect(frameCallbacks.size).toBe(1);
    detach();
    expect(frameCallbacks.size).toBe(0);
    unmount();
  });
});

/**
 * The echo guard is a pure state machine over (claimed position, live
 * geometry), so it is unit-testable against a scripted scroller — the browser
 * suite owns the real-geometry ordering proof
 * (assistant-scroll-to-bottom.browser.test.tsx). Both matter: this file pins
 * WHICH event disengages, that one pins that the interleaving is reachable.
 */
interface ScriptedScroller {
  readonly element: HTMLElement;
  readonly resize: (next: { clientHeight?: number; scrollHeight?: number }) => void;
  readonly scrollTop: () => number;
  readonly userScrollTo: (top: number) => void;
}

const createScriptedScroller = (scrollHeight: number, clientHeight: number): ScriptedScroller => {
  let currentScrollHeight = scrollHeight;
  let currentClientHeight = clientHeight;
  let currentTop = 0;
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientHeight: { get: () => currentClientHeight },
    scrollHeight: { get: () => currentScrollHeight },
    scrollTop: {
      get: () => currentTop,
      set: (next: number) => {
        currentTop = Math.max(0, Math.min(next, currentScrollHeight - currentClientHeight));
      },
    },
  });
  Object.defineProperty(element, 'scrollTo', {
    value: (options: ScrollToOptions): void => {
      element.scrollTop = options.top ?? currentTop;
    },
  });
  return {
    element,
    resize: (next) => {
      currentScrollHeight = next.scrollHeight ?? currentScrollHeight;
      currentClientHeight = next.clientHeight ?? currentClientHeight;
    },
    scrollTop: () => currentTop,
    userScrollTo: (top) => {
      element.scrollTop = top;
    },
  };
};

describe('own-write echo guard (BST-1039)', () => {
  const attachScripted = (scroller: ScriptedScroller) => {
    const { result, unmount } = renderHook(useThreadScrollFollow, { wrapper: FollowProvider });
    const follow = result.current;
    const detach = follow.attach(scroller.element);
    const callback = mutationCallback;
    if (!callback) {
      throw new Error('Thread scroll follow did not attach its mutation observer.');
    }
    const observeContentChange = (): void => {
      callback(
        [{ attributeName: null, type: 'characterData' } as unknown as MutationRecord],
        {} as unknown as MutationObserver
      );
    };
    return { detach, follow, observeContentChange, unmount };
  };

  test.each([false, true])(
    'preserves pinned=%s while an inactive workspace tab has zero geometry',
    (pinned) => {
      const scroller = createScriptedScroller(1000, 100);
      const { detach, follow, observeContentChange, unmount } = attachScripted(scroller);
      follow.jumpToBottomInstant();
      scroller.element.dispatchEvent(new Event('scroll'));
      if (!pinned) {
        scroller.userScrollTo(0);
        scroller.element.dispatchEvent(new Event('scroll'));
      }
      expect(follow.getIsAtBottom()).toBe(pinned);
      scroller.resize({ clientHeight: 0, scrollHeight: 0 });
      observeContentChange();
      scroller.element.dispatchEvent(new Event('scroll'));
      expect(follow.getIsAtBottom()).toBe(pinned);
      scroller.resize({ clientHeight: 100, scrollHeight: 1200 });
      // Chromium may restore an anchor displaced by hidden-tab layout.
      scroller.userScrollTo(90);
      observeContentChange();
      flushAnimationFrames();
      expect(follow.getIsAtBottom()).toBe(pinned);
      expect(scroller.scrollTop()).toBe(pinned ? 1100 : 0);
      detach();
      unmount();
    }
  );

  test('swallows the echo of its own moving write, then re-sticks through the resize', () => {
    const scroller = createScriptedScroller(1000, 100);
    const { detach, follow, observeContentChange, unmount } = attachScripted(scroller);

    // A moving follow write: this is the one whose echo is still in flight.
    scroller.resize({ scrollHeight: 1100 });
    observeContentChange();
    expect(scroller.scrollTop()).toBe(1000);

    // The viewport is squeezed and the content grows before that echo lands —
    // geometry no observer has measured yet.
    scroller.resize({ clientHeight: 35, scrollHeight: 1130 });
    scroller.element.dispatchEvent(new Event('scroll'));

    // The event moved nothing the engine did not already judge, so follow holds
    // and the next measurement re-sticks to the new bottom.
    expect(follow.getIsAtBottom()).toBe(true);
    observeContentChange();
    expect(scroller.scrollTop()).toBe(1095);

    detach();
    unmount();
  });

  test('disengages on a reader scroll delivered in that same window', () => {
    const scroller = createScriptedScroller(1000, 100);
    const { detach, follow, observeContentChange, unmount } = attachScripted(scroller);

    scroller.resize({ scrollHeight: 1100 });
    observeContentChange();
    scroller.resize({ clientHeight: 35, scrollHeight: 1130 });

    // Same unmeasured-geometry window, but the reader moved the position.
    scroller.userScrollTo(0);
    scroller.element.dispatchEvent(new Event('scroll'));

    expect(follow.getIsAtBottom()).toBe(false);
    detach();
    unmount();
  });

  test('leaves no claim behind when a write moves nothing', () => {
    const scroller = createScriptedScroller(1000, 100);
    const { detach, follow, observeContentChange, unmount } = attachScripted(scroller);

    scroller.resize({ scrollHeight: 1100 });
    observeContentChange();
    expect(scroller.scrollTop()).toBe(1000);

    // Dimensions change but the bottom does not move, so this write is a no-op
    // and the browser dispatches no scroll event for it. Claiming here would
    // leave an unconsumable claim parked on 1000.
    scroller.resize({ clientHeight: 150, scrollHeight: 1150 });
    observeContentChange();
    expect(scroller.scrollTop()).toBe(1000);

    // Content grows without a measurement, so 1000 is no longer the bottom, and
    // a reader event lands on exactly that pixel — a coalesced round trip. A
    // lingering claim would swallow it and the next measure would yank them.
    scroller.resize({ scrollHeight: 1250 });
    scroller.element.dispatchEvent(new Event('scroll'));

    expect(follow.getIsAtBottom()).toBe(false);
    detach();
    unmount();
  });
});
