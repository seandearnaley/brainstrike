import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUndoableAction } from '../hooks/use-undoable-action';

// Mock the useToast hook
const mockDismiss = vi.fn();
const mockToast = vi.fn().mockReturnValue({ id: 'test-toast-id' });

vi.mock('../use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
    dismiss: mockDismiss,
  }),
}));

describe('useUndoableAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns performUndoableAction and clearUndoTimeout functions', () => {
    const { result } = renderHook(() => useUndoableAction());

    expect(result.current.performUndoableAction).toBeDefined();
    expect(typeof result.current.performUndoableAction).toBe('function');
    expect(result.current.clearUndoTimeout).toBeDefined();
    expect(typeof result.current.clearUndoTimeout).toBe('function');
  });

  it('shows toast when performUndoableAction is called', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item description',
          onUndo: vi.fn(),
        }
      );
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Action',
        duration: 5000,
      })
    );
  });

  it('uses custom duration when provided', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          duration: 10_000,
          onUndo: vi.fn(),
        }
      );
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        duration: 10_000,
      })
    );
  });

  it('clears previous timeout when same key is used', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'same-key',
        { id: '1' },
        {
          actionName: 'Action 1',
          itemDescription: 'Item 1',
          onUndo: vi.fn(),
        }
      );
    });

    act(() => {
      result.current.performUndoableAction(
        'same-key',
        { id: '2' },
        {
          actionName: 'Action 2',
          itemDescription: 'Item 2',
          onUndo: vi.fn(),
        }
      );
    });

    // The dismiss should have been called to clear the first toast
    expect(mockDismiss).toHaveBeenCalled();
  });

  it('clearUndoTimeout dismisses toast and clears timeout', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          onUndo: vi.fn(),
        }
      );
    });

    act(() => {
      result.current.clearUndoTimeout('test-key');
    });

    expect(mockDismiss).toHaveBeenCalledWith('test-toast-id');
  });

  it('clearUndoTimeout does nothing for non-existent key', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.clearUndoTimeout('non-existent-key');
    });

    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('auto-clears after duration expires', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          duration: 3000,
          onUndo: vi.fn(),
        }
      );
    });

    // Fast-forward time
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockDismiss).toHaveBeenCalled();
  });

  it('calls getStateSnapshot when provided', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }, { state: string }>());
    const getStateSnapshot = vi.fn().mockReturnValue({ state: 'snapshot' });

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          onUndo: vi.fn(),
          getStateSnapshot,
        }
      );
    });

    expect(getStateSnapshot).toHaveBeenCalled();
  });

  it('cleans up timeouts on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { result, unmount } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'key1',
        { id: '1' },
        {
          actionName: 'Action 1',
          itemDescription: 'Item 1',
          onUndo: vi.fn(),
        }
      );
    });

    act(() => {
      result.current.performUndoableAction(
        'key2',
        { id: '2' },
        {
          actionName: 'Action 2',
          itemDescription: 'Item 2',
          onUndo: vi.fn(),
        }
      );
    });

    unmount();

    // Should clear all timeouts on unmount
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('handles multiple actions with different keys', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'key1',
        { id: '1' },
        {
          actionName: 'Action 1',
          itemDescription: 'Item 1',
          onUndo: vi.fn(),
        }
      );
    });

    act(() => {
      result.current.performUndoableAction(
        'key2',
        { id: '2' },
        {
          actionName: 'Action 2',
          itemDescription: 'Item 2',
          onUndo: vi.fn(),
        }
      );
    });

    // Both toasts should be created
    expect(mockToast).toHaveBeenCalledTimes(2);
  });

  it('generates fallback toast id when toast returns undefined', () => {
    mockToast.mockReturnValueOnce(undefined);

    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          onUndo: vi.fn(),
        }
      );
    });

    // Should not throw and should still work
    expect(mockToast).toHaveBeenCalled();
  });

  it('uses default duration of 5000ms when not specified', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'Test Action',
          itemDescription: 'Test item',
          onUndo: vi.fn(),
        }
      );
    });

    // Check that default duration is used
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        duration: 5000,
      })
    );

    // Auto-clear should happen at 5000ms
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockDismiss).toHaveBeenCalled();
  });
});
