import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { useUndoableAction } from '../use-undoable-action';

// Mock toast function
const mockToast = jest.fn().mockReturnValue({
  id: 'mock-toast-id',
  dismiss: jest.fn(),
});

// Mock dependencies
jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}));

// Mock window.clearTimeout
const mockClearTimeout = jest.fn();
global.clearTimeout = mockClearTimeout;

// Mock window.setTimeout
const mockSetTimeout = Object.assign(
  jest.fn((fn) => {
    fn();
    return 123;
  }),
  { __promisify__: jest.fn() }
);
global.setTimeout = mockSetTimeout as unknown as typeof global.setTimeout;

describe('useUndoableAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockToast.mockClear();
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
      const mockOnUndo = jest.fn();
      const mockSnapshot = new Set(['item1', 'item2']);

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Description',
          getStateSnapshot: () => mockSnapshot,
          onUndo: mockOnUndo,
        });
      });

      // Verify toast was called with correct parameters
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Action',
          description: expect.objectContaining({
            type: 'div',
            props: expect.objectContaining({
              className: 'flex items-center justify-between',
              children: expect.arrayContaining([
                expect.objectContaining({
                  type: 'span',
                  props: expect.objectContaining({
                    children: 'Test Description',
                  }),
                }),
                expect.objectContaining({
                  props: expect.objectContaining({
                    children: 'Undo',
                    variant: 'outline',
                    size: 'sm',
                  }),
                }),
              ]),
            }),
          }),
          duration: 5000,
        })
      );
    });

    it('should clear timeout when unmounted', () => {
      const { result, unmount } = renderUseUndoableActionHook();

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Description',
          onUndo: jest.fn(),
        });
      });

      unmount();
      expect(mockClearTimeout).toHaveBeenCalled();
    });

    it('should handle undo action correctly', async () => {
      const { result } = renderUseUndoableActionHook();
      const mockOnUndo = jest.fn();
      const mockSnapshot = new Set(['item1', 'item2']);

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Description',
          getStateSnapshot: () => mockSnapshot,
          onUndo: mockOnUndo,
        });
      });

      // Get the onClick handler from the toast call
      const toastCall = mockToast.mock.calls[0][0];
      const description = toastCall.description;
      const undoButton = description.props.children[1];

      // Simulate clicking the undo button
      act(() => {
        undoButton.props.onClick();
      });

      expect(mockOnUndo).toHaveBeenCalledWith('test-item', mockSnapshot);
    });

    it('should clear existing timeout when performing new action with same key', () => {
      const { result } = renderUseUndoableActionHook();

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item-1', {
          actionName: 'Test Action 1',
          itemDescription: 'Test Description 1',
          onUndo: jest.fn(),
        });
      });

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item-2', {
          actionName: 'Test Action 2',
          itemDescription: 'Test Description 2',
          onUndo: jest.fn(),
        });
      });

      expect(mockClearTimeout).toHaveBeenCalled();
    });

    it('should auto-dismiss after duration', () => {
      const { result } = renderUseUndoableActionHook();

      act(() => {
        result.current.performUndoableAction('test-key', 'test-item', {
          actionName: 'Test Action',
          itemDescription: 'Test Description',
          duration: 1000,
          onUndo: jest.fn(),
        });
      });

      expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    });
  });
});
