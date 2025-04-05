import * as React from 'react';
import { Button } from '../components/ui/button';
import { useToast } from '../components/ui/use-toast';
export function useUndoableAction() {
    const { toast } = useToast();
    const [undoTimeouts, setUndoTimeouts] = React.useState(new Map());
    React.useEffect(() => {
        return () => {
            // Clear all timeouts on unmount
            for (const { timeoutId } of undoTimeouts.values()) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [undoTimeouts]);
    const clearUndoTimeout = React.useCallback((key) => {
        const timeout = undoTimeouts.get(key);
        if (timeout) {
            window.clearTimeout(timeout.timeoutId);
            setUndoTimeouts((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
        }
    }, [undoTimeouts]);
    const performUndoableAction = React.useCallback((key, item, options) => {
        // Clear existing timeout for this key if it exists
        clearUndoTimeout(key);
        // Capture state snapshot if provided
        const snapshot = options.getStateSnapshot?.();
        // Call toast and handle the case when it returns undefined (for testing)
        const toastResult = toast({
            title: options.actionName,
            description: React.createElement('div', { className: 'flex items-center justify-between' }, React.createElement('span', null, options.itemDescription), React.createElement(Button, {
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                    options.onUndo(item, snapshot);
                    clearUndoTimeout(key);
                    // Only call dismiss if it exists
                    if (toastResult?.dismiss) {
                        toastResult.dismiss();
                    }
                },
            }, 'Undo')),
            duration: options.duration ?? 5000,
        });
        // Handle the case when toast returns undefined (for testing)
        const toastId = toastResult?.id || `toast-${key}-${Date.now()}`;
        // We don't need to use dismiss here since we're calling it conditionally in the onClick handler
        // Set a timeout to auto-dismiss after duration
        const timeoutId = window.setTimeout(() => {
            clearUndoTimeout(key);
        }, options.duration ?? 5000);
        // Store the timeout and item info
        setUndoTimeouts((prev) => {
            const next = new Map(prev);
            next.set(key, { timeoutId, toastId, item, snapshot });
            return next;
        });
    }, [clearUndoTimeout, toast]);
    return {
        performUndoableAction,
        clearUndoTimeout,
    };
}
