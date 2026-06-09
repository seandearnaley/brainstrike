import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResyncOnReturnToVisibility } from '../use-resync-on-return-to-visibility';

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

afterEach(() => {
  if (visibilityDescriptor) {
    Object.defineProperty(Document.prototype, 'visibilityState', visibilityDescriptor);
  }
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useResyncOnReturnToVisibility', () => {
  it('does not trigger on mount while visible', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    expect(triggerResync).not.toHaveBeenCalled();
  });

  it('triggers exactly once per hidden -> visible transition', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('hidden');
    expect(triggerResync).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(triggerResync).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    expect(triggerResync).toHaveBeenCalledTimes(2);
  });

  it('ignores repeated visible events without an intervening hidden state', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('visible');
    setVisibility('visible');

    expect(triggerResync).not.toHaveBeenCalled();
  });

  it('uses the latest callback when the transition fires', () => {
    overrideVisibility('visible');
    const stale = vi.fn();
    const fresh = vi.fn();

    const { rerender } = renderHook(({ trigger }) => useResyncOnReturnToVisibility(trigger), {
      initialProps: { trigger: stale },
    });

    rerender({ trigger: fresh });
    setVisibility('hidden');
    setVisibility('visible');

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does not trigger on mount while hidden, but does on the first return to visibility', () => {
    overrideVisibility('hidden');
    const triggerResync = vi.fn();

    renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    expect(triggerResync).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(triggerResync).toHaveBeenCalledTimes(1);
  });

  it('stops listening after unmount', () => {
    overrideVisibility('visible');
    const triggerResync = vi.fn();

    const { unmount } = renderHook(() => useResyncOnReturnToVisibility(triggerResync));

    setVisibility('hidden');
    unmount();
    setVisibility('visible');

    expect(triggerResync).not.toHaveBeenCalled();
  });
});
