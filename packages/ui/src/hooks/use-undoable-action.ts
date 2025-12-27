import * as React from 'react';
import { Button } from '../button';
import { useToast } from '../use-toast';

export type UndoableActionOptions<T, S = unknown> = {
  actionName: string;
  itemDescription: string;
  duration?: number;
  onUndo: (item: T, snapshot: S) => void;
  getStateSnapshot?: () => S;
};

export function useUndoableAction<T, S = unknown>() {
  const { toast, dismiss } = useToast();
  const undoTimeoutsRef = React.useRef<
    Map<string, { timeoutId: number; toastId: string; item: T; snapshot: S }>
  >(new Map());

  React.useEffect(
    () => () => {
      for (const { timeoutId } of undoTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
    },
    []
  );

  const clearUndoTimeout = React.useCallback(
    (key: string) => {
      const timeoutDetails = undoTimeoutsRef.current.get(key);
      if (timeoutDetails) {
        window.clearTimeout(timeoutDetails.timeoutId);
        dismiss(timeoutDetails.toastId);
        undoTimeoutsRef.current.delete(key);
      }
    },
    [dismiss]
  );

  const performUndoableAction = React.useCallback(
    (key: string, item: T, options: UndoableActionOptions<T, S>) => {
      clearUndoTimeout(key);
      const snapshot = options.getStateSnapshot?.() as S;
      const toastResult = toast({
        title: options.actionName,
        description: React.createElement(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          React.createElement(
            'span',
            { className: 'min-w-0 flex-1 truncate', title: options.itemDescription },
            options.itemDescription
          ),
          React.createElement(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              className: 'flex-shrink-0',
              onClick: () => {
                options.onUndo(item, snapshot);
                clearUndoTimeout(key);
              },
            },
            'Undo'
          )
        ),
        duration: options.duration ?? 5000,
      });
      const toastId = toastResult?.id || `toast-${key}-${Date.now()}`;
      const timeoutId = window.setTimeout(() => {
        clearUndoTimeout(key);
      }, options.duration ?? 5000);
      undoTimeoutsRef.current.set(key, { timeoutId, toastId, item, snapshot });
    },
    [toast, clearUndoTimeout]
  );

  return {
    performUndoableAction,
    clearUndoTimeout,
  };
}
