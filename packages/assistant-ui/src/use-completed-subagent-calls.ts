import type { PartState } from '@assistant-ui/react';
import { use, useCallback, useMemo, useSyncExternalStore } from 'react';
import { readSubagentInvocationRun } from './subagent-conversation-navigation';
import { SubagentInvocationIndexContext } from './subagent-invocation-index-context';
import { completedSubagentInvocationKey } from './subagent-invocation-index-model';
import { isSubagentDelegationToolName } from './subagent-tool-cards';

/** A terminal native invocation can settle its retained paused display copies. */
export function useCompletedSubagentCalls(parts: readonly PartState[]): ReadonlySet<string> {
  const index = use(SubagentInvocationIndexContext);
  const owners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const part of parts) {
      if (part.type === 'tool-call') {
        counts.set(part.toolCallId, (counts.get(part.toolCallId) ?? 0) + 1);
      }
    }
    const keys = new Map<string, string>();
    for (const part of parts) {
      if (
        part.type !== 'tool-call' ||
        part.result !== undefined ||
        part.status.type !== 'requires-action' ||
        !isSubagentDelegationToolName(part.toolName) ||
        counts.get(part.toolCallId) !== 1
      ) {
        continue;
      }
      const invocation = readSubagentInvocationRun(parts, part.toolCallId);
      if (invocation.kind !== 'available') {
        continue;
      }
      keys.set(
        part.toolCallId,
        completedSubagentInvocationKey(
          invocation.parentRuntimeRunId,
          part.toolCallId,
          part.toolName
        )
      );
    }
    return keys;
  }, [parts]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = [...owners.values()].map((key) => index?.subscribeCompleted(key, listener));
      return () => {
        for (const release of releases) {
          release?.();
        }
      };
    },
    [index, owners]
  );
  const read = useCallback(
    () =>
      JSON.stringify(
        [...owners].filter(([, key]) => index?.getCompletedSnapshot(key)).map(([call]) => call)
      ),
    [index, owners]
  );
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot]);
}
