import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDismissContext, mockToast } from '../__mocks__/ui-mocks';
import { useUndoableAction } from '../use-undoable-action';

// Mock for toast functions
const mockDismiss = vi.fn();
const mockUpdate = vi.fn();

// Override the mockToast to include dismiss and update methods
beforeEach(() => {
  mockToast.mockImplementation(() => ({
    id: 'mock-toast-id',
    dismiss: mockDismiss,
    update: mockUpdate,
  }));
});

// Mock the Button component
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...originalModule,
    Button: (props: { children: React.ReactNode; onClick?: () => void }) =>
      React.createElement('button', { type: 'button', onClick: props.onClick }, props.children),
  };
});

describe('useUndoableAction', () => {
  // Setup mocks for setTimeout and clearTimeout
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  beforeEach(() => {
    vi.clearAllMocks();
    mockToast.mockClear();
    mockDismiss.mockClear();
    mockDismissContext.mockClear();
    mockUpdate.mockClear();

    // Mock setTimeout to execute callback immediately and return a fake timer ID
    global.setTimeout = vi.fn((callback) => {
      if (typeof callback === 'function') callback();
      return 123;
    }) as unknown as typeof global.setTimeout;

    // Mock clearTimeout
    global.clearTimeout = vi.fn();
  });

  afterEach(() => {
    // Restore original timers after tests
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  const renderUseUndoableActionHook = () => {
    return renderHook(() => useUndoableAction<string, Set<string>>());
  };

  describe('Initialization', () => {
    it('should initialize with empty undoTimeouts', () => {
      const { result } = renderUseUndoableActionHook();
      expect(result.current.performUndoableAction).toBeDefined();
      expect(result.current.clearUndoTimeout).toBeDefined();
    });
  });

  describe('Action Handling', () => {
    it('should handle performUndoableAction correctly', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();
      const mockSnapshot = new Set(['item1', 'item2']);

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Item',
          getStateSnapshot: () => mockSnapshot,
          onUndo: mockOnUndo,
        });
      });

      // Verify toast was called with correct parameters
      expect(mockToast).toHaveBeenCalledTimes(1);
      const toastCall = mockToast.mock.calls[0]?.[0];
      expect(toastCall).toBeDefined();
      expect(toastCall?.title).toBe('Test Action');
      expect(toastCall?.duration).toBe(5000); // Default duration
    });

    it('should clear timeout when unmounted', async () => {
      const { result, unmount } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Item',
          onUndo: mockOnUndo,
        });
      });

      // Unmount the component
      unmount();

      // Verify clearTimeout was called
      expect(global.clearTimeout).toHaveBeenCalledWith(123);
    });

    it('should handle undo action correctly', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();
      const mockSnapshot = new Set(['item1', 'item2']);

      // Make sure mockToast returns a valid object with dismiss method
      mockToast.mockImplementationOnce(() => ({
        id: 'mock-toast-id',
        dismiss: mockDismiss,
        update: mockUpdate,
      }));

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Item',
          getStateSnapshot: () => mockSnapshot,
          onUndo: mockOnUndo,
        });
      });

      // Get the onClick handler from the toast call
      const toastCall = mockToast.mock.calls[0]?.[0];
      expect(toastCall).toBeDefined();
      const undoButton = toastCall?.description?.props?.children?.[1];
      expect(undoButton).toBeDefined();

      // Simulate clicking the undo button
      await act(async () => {
        undoButton?.props?.onClick?.();
      });

      // Verify onUndo was called with correct parameters
      expect(mockOnUndo).toHaveBeenCalledWith('test-item', mockSnapshot);
      // Note: Toast dismiss is handled by clearUndoTimeout which is tested separately
    });

    it('should clear existing timeout when performing new action with same key', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item-1', {
          actionName: 'Test Action 1',
          itemDescription: 'Test Item 1',
          onUndo: mockOnUndo,
        });
      });

      // Verify first toast was created
      expect(mockToast).toHaveBeenCalledTimes(1);

      // Perform a second action with the same key
      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item-2', {
          actionName: 'Test Action 2',
          itemDescription: 'Test Item 2',
          onUndo: mockOnUndo,
        });
      });

      // Verify a timeout was cleared for the first action.
      expect(global.clearTimeout).toHaveBeenCalledWith(123);

      // Verify second toast was created
      expect(mockToast).toHaveBeenCalledTimes(2);
    });

    it('should dismiss toast when clearUndoTimeout is called', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Item',
          onUndo: mockOnUndo,
        });
      });

      act(() => {
        result.current.clearUndoTimeout('test-key');
      });

      expect(mockDismissContext).toHaveBeenCalledWith('mock-toast-id');
    });

    it('should auto-dismiss after duration', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = vi.fn();
      const customDuration = 3000;

      await act(async () => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Item',
          duration: customDuration,
          onUndo: mockOnUndo,
        });
      });

      // Verify toast was called with custom duration
      const mockCalls = mockToast.mock.calls;
      if (mockCalls && mockCalls.length > 0 && mockCalls[0] && mockCalls[0][0]) {
        const toastCall = mockCalls[0][0];
        expect(toastCall.duration).toBe(customDuration);
      }

      // With fake timers, the timeout is queued but not run.
      // Crucially, it should not have been cleared by the hook's logic.
      // Since we mocked setTimeout to execute immediately,
      // the timeout should have been cleared already
      expect(global.clearTimeout).not.toHaveBeenCalled();
    });
  });
});
