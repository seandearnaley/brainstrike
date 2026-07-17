import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useKeyboardCancellation } from '../../hooks/use-keyboard-cancellation';

describe('useKeyboardCancellation', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it('should not add event listener when not loading', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(false, true, false, onCancel));

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should not add event listener when not cancellable', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, false, false, onCancel));

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should not add event listener when already cancelling', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, true, true, onCancel));

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should not add event listener when onCancel is undefined', () => {
    renderHook(() => useKeyboardCancellation(true, true, false, undefined));

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should add event listener when loading, cancellable, not cancelling, and has onCancel', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, true, false, onCancel));

    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should call onCancel when Escape key is pressed', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, true, false, onCancel));

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    const preventDefaultSpy = vi.spyOn(escapeEvent, 'preventDefault');

    document.dispatchEvent(escapeEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should not call onCancel for other keys', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, true, false, onCancel));

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter' });
    document.dispatchEvent(enterEvent);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('should remove event listener on unmount', () => {
    const onCancel = vi.fn();

    const { unmount } = renderHook(() => useKeyboardCancellation(true, true, false, onCancel));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should remove and re-add event listener when dependencies change', () => {
    const onCancel = vi.fn();

    const { rerender } = renderHook(
      ({ isLoading, cancellable, isCancelling, onCancelFn }) =>
        useKeyboardCancellation(isLoading, cancellable, isCancelling, onCancelFn),
      {
        initialProps: {
          cancellable: true,
          isCancelling: false,
          isLoading: true,
          onCancelFn: onCancel,
        },
      }
    );

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);

    // Change to not cancellable
    rerender({ cancellable: false, isCancelling: false, isLoading: true, onCancelFn: onCancel });

    expect(removeEventListenerSpy).toHaveBeenCalled();
  });

  it('should handle multiple Escape key presses', () => {
    const onCancel = vi.fn();

    renderHook(() => useKeyboardCancellation(true, true, false, onCancel));

    const escapeEvent1 = new KeyboardEvent('keydown', { key: 'Escape' });
    const escapeEvent2 = new KeyboardEvent('keydown', { key: 'Escape' });

    document.dispatchEvent(escapeEvent1);
    document.dispatchEvent(escapeEvent2);

    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
