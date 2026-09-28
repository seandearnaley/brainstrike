import { useAuiState } from '@assistant-ui/react';
import { useEffect } from 'react';

/**
 * Render-nothing leaf that reports this panel's OWN `thread.isRunning` for the
 * thread it shows (`threadKey`) to its owner (BST-1844): the thread-tab
 * workspace keeps a panel alive when its tab closes mid-run, and must decide
 * that from the runtime that owns the run, not from the durable run row (which
 * lags the send and can outlive the run).
 *
 * Reports the current value on mount and on every change, and `false` on
 * unmount, so an owner never keeps a running flag for a panel that is gone.
 */
export function RunningStateBridge({
  onRunningChange,
  threadKey,
}: {
  readonly onRunningChange: (threadKey: string, running: boolean) => void;
  readonly threadKey: string;
}): null {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  useEffect(() => {
    onRunningChange(threadKey, isRunning);
  }, [isRunning, onRunningChange, threadKey]);
  useEffect(() => () => onRunningChange(threadKey, false), [onRunningChange, threadKey]);
  return null;
}
