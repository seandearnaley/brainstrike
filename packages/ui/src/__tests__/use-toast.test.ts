import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '../../src/use-toast';

describe('useToast', () => {
  beforeEach(() => {
    // Clear any existing toasts between tests
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.dismiss();
    });
    // Wait for removal timeout
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('should create a toast', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({
        description: 'This is a test toast',
        title: 'Test Toast',
      });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({
      description: 'This is a test toast',
      open: true,
      title: 'Test Toast',
    });
  });

  it('should dismiss a specific toast', () => {
    const { result } = renderHook(() => useToast());

    let toastId: string;
    act(() => {
      const { id } = result.current.toast({
        title: 'Test Toast',
      });
      toastId = id;
    });

    expect(result.current.toasts[0]?.open).toBe(true);

    act(() => {
      result.current.dismiss(toastId);
    });

    expect(result.current.toasts[0]?.open).toBe(false);
  });

  it('should dismiss all toasts when no id is provided', () => {
    const { result } = renderHook(() => useToast());

    // Create toasts one at a time to ensure proper state updates
    act(() => {
      result.current.toast({ title: 'Toast 1' });
    });

    act(() => {
      result.current.toast({ title: 'Toast 2' });
    });

    expect(result.current.toasts.filter((t) => t.open)).toHaveLength(2);
    expect(result.current.toasts.filter((t) => t.open).every((t) => t.open)).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.toasts.every((t) => !t.open)).toBe(true);
  });

  it('should update an existing toast', () => {
    const { result } = renderHook(() => useToast());

    let toastId: string;
    act(() => {
      const { id, update } = result.current.toast({
        title: 'Original Title',
      });
      toastId = id;
      update({
        id: toastId,
        title: 'Updated Title',
      });
    });

    const updatedToast = result.current.toasts.find((t) => t.id === toastId);
    expect(updatedToast?.title).toBe('Updated Title');
  });

  it('should respect TOAST_LIMIT', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      // Create more toasts than the limit
      for (let i = 0; i < 15; i++) {
        result.current.toast({
          title: `Toast ${i}`,
        });
      }
    });

    expect(result.current.toasts.length).toBeLessThanOrEqual(10); // TOAST_LIMIT is 10
  });

  it('should remove toast after onOpenChange', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());

    let toastId: string;
    act(() => {
      const { id } = result.current.toast({
        title: 'Test Toast',
      });
      toastId = id;
    });

    const toast = result.current.toasts.find((t) => t.id === toastId);
    expect(toast).toBeDefined();

    // Simulate onOpenChange being called with false
    act(() => {
      toast?.onOpenChange?.(false);
    });

    // Fast-forward timers to trigger the removal
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.toasts.find((t) => t.id === toastId)).toBeUndefined();
    vi.useRealTimers();
  });

  it('should auto-dismiss and remove a toast when duration is provided', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());

    let toastId: string;
    act(() => {
      const { id } = result.current.toast({
        duration: 4000,
        title: 'Timed Toast',
      });
      toastId = id;
    });

    expect(result.current.toasts.find((t) => t.id === toastId)?.open).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts.find((t) => t.id === toastId)?.open).toBe(false);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.toasts.find((t) => t.id === toastId)).toBeUndefined();
    vi.useRealTimers();
  });

  it('should generate unique ids for each toast', () => {
    const { result } = renderHook(() => useToast());
    const ids = new Set<string>();

    act(() => {
      for (let i = 0; i < 5; i++) {
        const { id } = result.current.toast({
          title: `Toast ${i}`,
        });
        ids.add(id);
      }
    });

    expect(ids.size).toBe(5); // All IDs should be unique
  });
});
