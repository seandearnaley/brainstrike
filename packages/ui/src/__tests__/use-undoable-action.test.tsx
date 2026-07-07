import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUndoableAction } from '../hooks/use-undoable-action';

// Mock the useToast hook
const mockDismiss = vi.fn();
const mockToast = vi.fn().mockReturnValue({ id: 'test-toast-id' });

vi.mock('../use-toast', () => ({
  useToast: () => ({
    dismiss: mockDismiss,
    toast: mockToast,
  }),
}));

describe('useUndoableAction', () => {
  const renderToastDescription = (callIndex = 0) => {
    const toastCall = mockToast.mock.calls[callIndex]?.[0];
    expect(toastCall?.description).toBeDefined();
    return render(toastCall.description);
  };

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
        duration: 5000,
        title: 'Test Action',
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
          duration: 10_000,
          itemDescription: 'Test item',
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
          duration: 3000,
          itemDescription: 'Test item',
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
          getStateSnapshot,
          itemDescription: 'Test item',
          onUndo: vi.fn(),
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

  it('applies truncation classes to description for long paths', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());
    const longPath = '/Users/username/very/long/path/to/some/deeply/nested/file.ts';

    act(() => {
      result.current.performUndoableAction(
        'test-key',
        { id: '123' },
        {
          actionName: 'File removed',
          itemDescription: `Removed "${longPath}" from selection`,
          onUndo: vi.fn(),
        }
      );
    });

    const { container } = renderToastDescription();
    const descriptionElement = container.firstElementChild;
    const spanElement = screen.getByText(`Removed "${longPath}" from selection`);
    const buttonElement = screen.getByRole('button', { name: 'Undo' });

    expect(descriptionElement).toHaveClass('flex', 'items-center', 'justify-between', 'gap-2');
    expect(spanElement).toHaveClass('min-w-0', 'flex-1', 'truncate');
    expect(spanElement).toHaveAttribute('title', `Removed "${longPath}" from selection`);
    expect(buttonElement).toHaveClass('flex-shrink-0');
  });

  // ── Additional coverage tests ───────────────────────────────────────

  it('invokes onUndo with correct item and snapshot when undo button is clicked', () => {
    const onUndo = vi.fn();
    const getStateSnapshot = vi.fn().mockReturnValue({ order: [1, 2, 3] });

    const { result } = renderHook(() => useUndoableAction<{ id: string }, { order: number[] }>());

    act(() => {
      result.current.performUndoableAction(
        'undo-key',
        { id: 'item-42' },
        {
          actionName: 'Removed item',
          getStateSnapshot,
          itemDescription: 'item-42',
          onUndo,
        }
      );
    });

    // Extract the Button's onClick from the rendered description
    renderToastDescription();
    act(() => {
      screen.getByRole('button', { name: 'Undo' }).click();
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith({ id: 'item-42' }, { order: [1, 2, 3] });
    // Undo also clears the timeout
    expect(mockDismiss).toHaveBeenCalledWith('test-toast-id');
  });

  it('passes undefined snapshot when getStateSnapshot is not provided', () => {
    const onUndo = vi.fn();
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'no-snap',
        { id: 'x' },
        {
          actionName: 'Action',
          itemDescription: 'desc',
          onUndo,
        }
      );
    });

    renderToastDescription();
    act(() => {
      screen.getByRole('button', { name: 'Undo' }).click();
    });

    expect(onUndo).toHaveBeenCalledWith({ id: 'x' }, undefined);
  });

  it('renders the description text and undo action', () => {
    const { result } = renderHook(() => useUndoableAction<{ name: string }>());

    act(() => {
      result.current.performUndoableAction(
        'struct-key',
        { name: 'test' },
        {
          actionName: 'Struct Test',
          itemDescription: 'My description text',
          onUndo: vi.fn(),
        }
      );
    });

    renderToastDescription();

    expect(screen.getByText('My description text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('replaces existing action for same key and only the latest auto-clears', () => {
    const onUndo1 = vi.fn();
    const onUndo2 = vi.fn();
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    act(() => {
      result.current.performUndoableAction(
        'replace-key',
        { id: '1' },
        {
          actionName: 'First',
          duration: 3000,
          itemDescription: 'First item',
          onUndo: onUndo1,
        }
      );
    });

    // Replace with a second action on the same key
    act(() => {
      result.current.performUndoableAction(
        'replace-key',
        { id: '2' },
        {
          actionName: 'Second',
          duration: 3000,
          itemDescription: 'Second item',
          onUndo: onUndo2,
        }
      );
    });

    // After 3000ms, only the second action's timeout should fire
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Toast was called twice (once for each action)
    expect(mockToast).toHaveBeenCalledTimes(2);
    // Dismiss was called at least once for cleanup of the first toast
    expect(mockDismiss).toHaveBeenCalled();
  });

  it('handles fallback toast id correctly and still auto-clears', () => {
    // Return null id to force fallback
    mockToast.mockReturnValueOnce(null);
    const { result } = renderHook(() => useUndoableAction<string>());

    act(() => {
      result.current.performUndoableAction('fallback-key', 'item', {
        actionName: 'Fallback Test',
        duration: 2000,
        itemDescription: 'desc',
        onUndo: vi.fn(),
      });
    });

    // Auto-clear fires without errors
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Dismiss should be called with the fallback id
    expect(mockDismiss).toHaveBeenCalled();
  });

  it('clears specific key without affecting other keys', () => {
    const { result } = renderHook(() => useUndoableAction<{ id: string }>());

    mockToast.mockReturnValueOnce({ id: 'toast-a' }).mockReturnValueOnce({ id: 'toast-b' });

    act(() => {
      result.current.performUndoableAction(
        'key-a',
        { id: 'a' },
        {
          actionName: 'A',
          itemDescription: 'A',
          onUndo: vi.fn(),
        }
      );
    });

    act(() => {
      result.current.performUndoableAction(
        'key-b',
        { id: 'b' },
        {
          actionName: 'B',
          itemDescription: 'B',
          onUndo: vi.fn(),
        }
      );
    });

    mockDismiss.mockClear();

    // Clear only key-a
    act(() => {
      result.current.clearUndoTimeout('key-a');
    });

    expect(mockDismiss).toHaveBeenCalledWith('toast-a');
    expect(mockDismiss).toHaveBeenCalledTimes(1);

    // key-b should still auto-clear after timeout
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockDismiss).toHaveBeenCalledWith('toast-b');
  });
});
