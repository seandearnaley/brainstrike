import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESYNC_ON_VISIBILITY_SETTLE_MS,
  useResyncOnReturnToVisibility,
} from '../use-resync-on-return-to-visibility';

let visibilityState: DocumentVisibilityState = 'visible';
const visibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

function overrideVisibility(initial: DocumentVisibilityState): void {
  visibilityState = initial;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
}

function setVisibility(next: DocumentVisibilityState): void {
  act(() => {
    visibilityState = next;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (visibilityDescriptor) {
    Object.defineProperty(Document.prototype, 'visibilityState', visibilityDescriptor);
  }
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
});

describe('useResyncOnReturnToVisibility', () => {
  it('does not trigger on mount while visible', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS * 2);
    expect(triggerResync).not.toHaveBeenCalled();
  });

  it('triggers once after a sustained return to visibility', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('hidden');
    setVisibility('visible');
    // Not yet: the return must settle so alt-tab bursts don't each pay a scan.
    expect(triggerResync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of focus flips into a single resync', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    // Rapid alt-tabbing: hidden/visible several times within the settle window.
    for (let i = 0; i < 4; i++) {
      setVisibility('hidden');
      act(() => {
        vi.advanceTimersByTime(200);
      });
      setVisibility('visible');
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    expect(triggerResync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending resync when the document hides again before settling', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('hidden');
    setVisibility('visible');
    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS - 1);
    });
    setVisibility('hidden');

    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS * 2);
    });
    // Still hidden: nothing fires until the next sustained return.
    expect(triggerResync).not.toHaveBeenCalled();

    setVisibility('visible');
    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(1);
  });

  it('uses the latest callback when the settled transition fires', () => {
    overrideVisibility('visible');
    const stale = vi.fn();
    const fresh = vi.fn();

    const { rerender } = renderHook(({ trigger }) => useResyncOnReturnToVisibility(trigger), {
      initialProps: { trigger: stale },
    });

    rerender({ trigger: fresh });
    setVisibility('hidden');
    setVisibility('visible');
    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS);
    });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does not trigger on mount while hidden, but does on the first sustained return', () => {
    overrideVisibility('hidden');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    expect(triggerResync).not.toHaveBeenCalled();

    setVisibility('visible');
    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS);
    });
    expect(triggerResync).toHaveBeenCalledTimes(1);
  });

  it('stops listening and clears the pending timer after unmount', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    const { unmount } = renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('hidden');
    setVisibility('visible');
    unmount();

    act(() => {
      vi.advanceTimersByTime(RESYNC_ON_VISIBILITY_SETTLE_MS * 2);
    });
    expect(triggerResync).not.toHaveBeenCalled();
  });
});
