import { use, useCallback, useSyncExternalStore } from 'react';
import { SubagentInvocationIndexContext } from './subagent-invocation-index-context';
import type { SubagentInvocationSnapshot } from './subagent-invocation-index-model';

export function useSubagentInvocationSnapshot(
  parentToolCallId: string
): SubagentInvocationSnapshot {
  const index = use(SubagentInvocationIndexContext);
  if (!index) {
    throw new Error('Subagent delegation cards require SubagentInvocationIndexProvider');
  }
  const subscribe = useCallback(
    (listener: () => void) => index.subscribe(parentToolCallId, listener),
    [index, parentToolCallId]
  );
  const getSnapshot = useCallback(
    () => index.getSnapshot(parentToolCallId),
    [index, parentToolCallId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
