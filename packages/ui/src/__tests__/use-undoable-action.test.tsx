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

    const toastCall = mockToast.mock.calls[0]?.[0];
    expect(toastCall).toBeDefined();
    expect(toastCall.description).toBeDefined();

    const descriptionElement = toastCall.description;
    expect(descriptionElement.type).toBe('div');
    expect(descriptionElement.props.className).toContain('flex');
    expect(descriptionElement.props.className).toContain('items-center');
    expect(descriptionElement.props.className).toContain('justify-between');
    expect(descriptionElement.props.className).toContain('gap-2');

    const spanElement = descriptionElement.props.children[0];
    expect(spanElement.type).toBe('span');
    expect(spanElement.props.className).toContain('min-w-0');
    expect(spanElement.props.className).toContain('flex-1');
    expect(spanElement.props.className).toContain('truncate');

    expect(spanElement.props.title).toBe(`Removed "${longPath}" from selection`);

    const buttonElement = descriptionElement.props.children[1];
    expect(buttonElement.props.className).toContain('flex-shrink-0');
  });

  // ── Additional coverage tests ───────────────────────────────────────

  it('invokes onUndo with correct item and snapshot when undo button is clicked', () => {
    const onUndo = vi.fn();
    const getStateSnapshot = vi.fn().mockReturnValue({ order: [1, 2, 3] });

    const { result } = renderHook(() =>
      useUndoableAction<{ id: string }, { order: number[] }>()
    );

    act(() => {
      result.current.performUndoableAction(
        'undo-key',
        { id: 'item-42' },
        {
          actionName: 'Removed item',
          itemDescription: 'item-42',
          onUndo,
          getStateSnapshot,
        }
      );
    });

    // Extract the Button's onClick from the rendered description
    const toastCall = mockToast.mock.calls[0]?.[0];
    const descriptionElement = toastCall.description;
    const buttonElement = descriptionElement.props.children[1];

    // Simulate clicking the Undo button
    act(() => {
      buttonElement.props.onClick();
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

    const toastCall = mockToast.mock.calls[0]?.[0];
    const buttonElement = toastCall.description.props.children[1];

    act(() => {
      buttonElement.props.onClick();
    });

    expect(onUndo).toHaveBeenCalledWith({ id: 'x' }, undefined);
  });

  it('creates description with correct React element structure', () => {
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

    const toastCall = mockToast.mock.calls[0]?.[0];
    const desc = toastCall.description;

    // Root div
    expect(desc.type).toBe('div');
    // Children: [span, Button]
    expect(desc.props.children).toHaveLength(2);
    // Span shows item description
    expect(desc.props.children[0].props.children).toBe('My description text');
    // Button text is 'Undo'
    expect(desc.props.children[1].props.children).toBe('Undo');
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
          itemDescription: 'First item',
          onUndo: onUndo1,
          duration: 3000,
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
          itemDescription: 'Second item',
          onUndo: onUndo2,
          duration: 3000,
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
        itemDescription: 'desc',
        onUndo: vi.fn(),
        duration: 2000,
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
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    mockToast.mockReturnValueOnce({ id: 'toast-a' }).mockReturnValueOnce({ id: 'toast-b' });

    act(() => {
      result.current.performUndoableAction('key-a', { id: 'a' }, {
        actionName: 'A',
        itemDescription: 'A',
        onUndo: vi.fn(),
      });
    });

    act(() => {
      result.current.performUndoableAction('key-b', { id: 'b' }, {
        actionName: 'B',
        itemDescription: 'B',
        onUndo: vi.fn(),
      });
    });

    clearTimeoutSpy.mockClear();
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
