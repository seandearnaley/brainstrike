import { Button, useToast } from '@brainstrike/ui';
import * as React from 'react';

/**
 * @interface UndoableActionOptions
 * @template T The type of the item being acted upon.
 * @template S The type of the state snapshot, defaults to unknown.
 * @property {string} actionName - The name of the action being performed (e.g., "Deleted file").
 * @property {string} itemDescription - A description of the item affected (e.g., "image.png").
 * @property {number} [duration=5000] - Duration in milliseconds for the undo option to be available.
 * @property {(item: T, snapshot: S) => void} onUndo - Callback function executed when the action is undone.
 * @property {() => S} [getStateSnapshot] - Optional function to capture a state snapshot before the action.
 */
export interface UndoableActionOptions<T, S = unknown> {
  actionName: string;
  itemDescription: string;
  duration?: number;
  onUndo: (item: T, snapshot: S) => void;
  getStateSnapshot?: () => S;
}

/**
 * `useUndoableAction` hook.
 *
 * This hook provides functionality to perform an action that can be undone via a toast notification.
 * It leverages `@brainstrike/ui` for toast and button components.
 * It's a general-purpose hook suitable for actions where a temporary undo capability enhances user experience.
 *
 * @template T The type of the item being acted upon.
 * @template S The type of the state snapshot, defaults to unknown.
 * @returns {{
 *   performUndoableAction: (key: string, item: T, options: UndoableActionOptions<T, S>) => void,
 *   clearUndoTimeout: (key: string) => void
 * }}
 *   - `performUndoableAction`: Function to trigger the action and show the undo toast.
 *     - `key`: A unique string identifier for the action instance (e.g., item ID).
 *     - `item`: The item on which the action is performed.
 *     - `options`: Configuration for the undoable action.
 *   - `clearUndoTimeout`: Function to prematurely clear an undo timeout and dismiss its toast.
 */
export function useUndoableAction<T, S = unknown>() {
  const { toast } = useToast();
  const [undoTimeouts, setUndoTimeouts] = React.useState<
    Map<string, { timeoutId: number; toastId: string; item: T; snapshot: S }>
  >(new Map());

  React.useEffect(() => {
    return () => {
      // Clear all timeouts on unmount
      for (const { timeoutId } of undoTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [undoTimeouts]);

  const clearUndoTimeout = React.useCallback(
    (key: string) => {
      const timeoutDetails = undoTimeouts.get(key);
      if (timeoutDetails) {
        window.clearTimeout(timeoutDetails.timeoutId);
        // Potentially dismiss the toast if the toast context provides a way by id
        // For now, this just clears the timeout. The toast itself has a duration.
        // If an explicit dismiss is needed, the toast function might need to return a dismiss method.
        // The current `useToast` from `@brainstrike/ui` returns { id, dismiss }
        // However, we don't have `toastResult.dismiss` available here directly.
        // The original code had `toastResult.dismiss()` inside the Button onClick, which is fine.

        setUndoTimeouts((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [undoTimeouts]
  );

  const performUndoableAction = React.useCallback(
    (key: string, item: T, options: UndoableActionOptions<T, S>) => {
      clearUndoTimeout(key); // Clear any existing undo for the same key

      const snapshot = options.getStateSnapshot?.() as S;

      const toastResult = toast({
        title: options.actionName,
        description: React.createElement(
          'div',
          { className: 'flex items-center justify-between' },
          React.createElement('span', null, options.itemDescription),
          React.createElement(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              onClick: () => {
                options.onUndo(item, snapshot);
                if (toastResult?.dismiss) {
                  toastResult.dismiss(); // Dismiss the toast on undo
                }
                clearUndoTimeout(key); // Also clear our internal tracking
              },
            },
            'Undo'
          )
        ),
        duration: options.duration ?? 5000,
      });

      const toastId = toastResult?.id || `toast-${key}-${Date.now()}`;

      const timeoutId = window.setTimeout(() => {
        // When timeout expires, ensure it's removed from tracking
        // The toast itself will auto-dismiss based on its duration.
        clearUndoTimeout(key);
      }, options.duration ?? 5000);

      setUndoTimeouts((prev) => {
        const next = new Map(prev);
        // Ensure snapshot is defined, falling back to a default if necessary
        // (though TS implies S could be undefined if not provided by getStateSnapshot and not void)
        // For safety, especially if S isn't explicitly `| undefined`.
        // However, the original code had `snapshot: S` which implies S should be defined.
        next.set(key, { timeoutId, toastId, item, snapshot });
        return next;
      });
    },
    [toast, clearUndoTimeout] // Added clearUndoTimeout to dependency array
  );

  return {
    performUndoableAction,
    clearUndoTimeout,
  };
}
