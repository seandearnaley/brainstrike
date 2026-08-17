import * as React from 'react';
import type { ToastActionElement, ToastProps } from './toast';

const TOAST_LIMIT = 10;

/**
 * DURATION SEMANTICS (BST-1164 review — pinned, because two timers exist):
 * - `duration: <positive ms>` — this store schedules the dismissal itself
 *   (and the value is also forwarded to the Radix root).
 * - `persistent: true` — the toast NEVER auto-dismisses: the `Toaster`
 *   renders it with an infinite Radix `duration`, so neither the store nor
 *   Radix ever closes it; only an explicit dismiss (close button, action
 *   click, `dismiss()`) does. For affordances that must outlive a timer —
 *   e.g. the rewind redo toast, whose WINDOW stays open until the next user
 *   message finalizes the rewind.
 * - NEITHER — the Radix provider default applies (5s auto-dismiss). Omitting
 *   `duration` is NOT persistence; Radix's own default closes the toast.
 * `persistent` alongside a numeric `duration` is a contradiction and throws.
 */
type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  persistent?: boolean;
};

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
} as const;

let count = 0;
const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const TOAST_REMOVE_DELAY_MS = 100;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;

type Action =
  | {
      type: ActionType['ADD_TOAST'];
      toast: ToasterToast;
    }
  | {
      type: ActionType['UPDATE_TOAST'];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType['DISMISS_TOAST'];
      toastId?: ToasterToast['id'];
    }
  | {
      type: ActionType['REMOVE_TOAST'];
      toastId?: ToasterToast['id'];
    };

interface State {
  toasts: ToasterToast[];
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      };

    case 'DISMISS_TOAST': {
      const { toastId } = action;
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }

    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  for (const listener of listeners) {
    listener(memoryState);
  }
}

function clearToastTimeout(toastId: string): void {
  const timeoutId = toastTimeouts.get(toastId);
  if (!timeoutId) {
    return;
  }
  clearTimeout(timeoutId);
  toastTimeouts.delete(toastId);
}

function scheduleToastAutoDismiss(toastId: string, duration: number): void {
  clearToastTimeout(toastId);
  const timeoutId = setTimeout(() => {
    dispatch({ toastId, type: 'DISMISS_TOAST' });
    setTimeout(() => {
      dispatch({ toastId, type: 'REMOVE_TOAST' });
      clearToastTimeout(toastId);
    }, TOAST_REMOVE_DELAY_MS);
  }, duration);
  toastTimeouts.set(toastId, timeoutId);
}

type Toast = Omit<ToasterToast, 'id'>;

function toast({ ...props }: Toast) {
  if (props.persistent === true && typeof props.duration === 'number') {
    // Contradictory intent — refuse loudly rather than silently picking one.
    throw new Error('toast(): `persistent: true` cannot be combined with a numeric `duration`.');
  }
  const id = genId();

  const update = (props: ToasterToast) =>
    dispatch({
      toast: { ...props, id },
      type: 'UPDATE_TOAST',
    });
  const dismiss = () => dispatch({ toastId: id, type: 'DISMISS_TOAST' });

  dispatch({
    toast: {
      ...props,
      id,
      onOpenChange: (open) => {
        if (!open) {
          dismiss();
          // Remove toast after animation
          setTimeout(() => {
            dispatch({ toastId: id, type: 'REMOVE_TOAST' });
            clearToastTimeout(id);
          }, 100);
        }
      },
      open: true,
    },
    type: 'ADD_TOAST',
  });

  if (typeof props.duration === 'number' && props.duration > 0) {
    scheduleToastAutoDismiss(id, props.duration);
  }

  return {
    dismiss,
    id,
    update,
  };
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    dismiss: (toastId?: string) => {
      dispatch({
        type: 'DISMISS_TOAST',
        // Conditionally add toastId only if it exists to satisfy exactOptionalPropertyTypes
        ...(toastId && { toastId }),
      });
    },
    toast,
  };
}

/**
 * Drop every toast and its pending auto-dismiss timer.
 *
 * TEST HYGIENE SEAM, mirroring `resetFollowUpQueueStore`/`resetContextUsageStore`.
 * `memoryState` is module-scope, so toasts raised by one test are still mounted
 * during the next one — and a test that clicks "the toast's action button"
 * then silently drives the PREVIOUS test's closure instead of its own. That
 * fails with "not called", pointing nowhere near the cause.
 */
export function resetToastStore(): void {
  for (const toastId of [...toastTimeouts.keys()]) {
    clearToastTimeout(toastId);
  }
  memoryState = { toasts: [] };
  for (const listener of listeners) {
    listener(memoryState);
  }
}

export { toast, useToast };
