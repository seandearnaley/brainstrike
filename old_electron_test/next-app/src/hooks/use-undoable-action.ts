import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import * as React from 'react';

interface UndoableActionOptions<T, S = unknown> {
  actionName: string;
  itemDescription: string;
  duration?: number;
  onUndo: (item: T, snapshot: S) => void;
  getStateSnapshot?: () => S;
}

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
      const timeout = undoTimeouts.get(key);
      if (timeout) {
        window.clearTimeout(timeout.timeoutId);
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
      // Clear existing timeout for this key if it exists
      clearUndoTimeout(key);

      // Capture state snapshot if provided
      const snapshot = options.getStateSnapshot?.() as S;

      const { id: toastId, dismiss } = toast({
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
                clearUndoTimeout(key);
                dismiss();
              },
            },
            'Undo'
          )
        ),
        duration: options.duration ?? 5000,
      });

      // Set new timeout
      const timeoutId = window.setTimeout(() => {
        setUndoTimeouts((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }, options.duration ?? 5000);

      // Store the timeout and toast IDs
      setUndoTimeouts((prev) => {
        const next = new Map(prev);
        next.set(key, { timeoutId, toastId, item, snapshot });
        return next;
      });
    },
    [toast, clearUndoTimeout]
  );

  return {
    performUndoableAction,
    clearUndoTimeout,
  };
}
