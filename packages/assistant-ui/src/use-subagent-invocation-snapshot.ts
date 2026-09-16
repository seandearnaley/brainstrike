import { use, useSyncExternalStore } from 'react';
import { SubagentInvocationIndexContext } from './subagent-invocation-index-context';
import type { SubagentInvocationSnapshot } from './subagent-invocation-index-model';

export function useSubagentInvocationSnapshot(
  parentToolCallId: string
): SubagentInvocationSnapshot {
  const index = use(SubagentInvocationIndexContext);
  if (!index) {
    throw new Error('Subagent delegation cards require SubagentInvocationIndexProvider');
  }
  return useSyncExternalStore(
    (listener) => index.subscribe(parentToolCallId, listener),
    () => index.getSnapshot(parentToolCallId),
    () => index.getSnapshot(parentToolCallId)
  );
}
