import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelToggle } from '../use-panel-toggle';

describe('usePanelToggle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback): number => {
        callback(0);
        return 1;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('show lifts the init gate, runs before-show callback, toggles, and focuses after animation', () => {
    const toggleFn = vi.fn();
    const liftInitGate = vi.fn();
    const onBeforeShow = vi.fn();
    const focus = vi.fn();
    const focusRef = { current: { focus } as unknown as HTMLElement } as RefObject<HTMLElement>;

    const { result } = renderHook(() =>
      usePanelToggle(toggleFn, { focusRef, liftInitGate, onBeforeShow })
    );

    act(() => {
      result.current.show();
    });

    expect(liftInitGate).toHaveBeenCalledTimes(1);
    expect(onBeforeShow).toHaveBeenCalledTimes(1);
    expect(toggleFn).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('show tolerates callback errors and still toggles', () => {
    const toggleFn = vi.fn();
    const onBeforeShow = vi.fn(() => {
      throw new Error('boom');
    });

    const { result } = renderHook(() => usePanelToggle(toggleFn, { onBeforeShow }));

    act(() => {
      result.current.show();
    });

    expect(onBeforeShow).toHaveBeenCalledTimes(1);
    expect(toggleFn).toHaveBeenCalledTimes(1);
  });

  it('hide lifts init gate, tolerates callback errors, and toggles', () => {
    const toggleFn = vi.fn();
    const liftInitGate = vi.fn();
    const onBeforeHide = vi.fn(() => {
      throw new Error('boom');
    });

    const { result } = renderHook(() => usePanelToggle(toggleFn, { liftInitGate, onBeforeHide }));

    act(() => {
      result.current.hide();
    });

    expect(liftInitGate).toHaveBeenCalledTimes(1);
    expect(onBeforeHide).toHaveBeenCalledTimes(1);
    expect(toggleFn).toHaveBeenCalledTimes(1);
  });
});
