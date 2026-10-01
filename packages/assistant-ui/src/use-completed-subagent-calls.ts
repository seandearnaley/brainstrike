import { type PartState, useAuiState } from '@assistant-ui/react';
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { use, useCallback, useMemo, useSyncExternalStore } from 'react';
import { SubagentInvocationIndexContext } from './subagent-invocation-index-context';
import { completedSubagentInvocationKey } from './subagent-invocation-index-model';
import { isSubagentDelegationToolName } from './subagent-tool-cards';

/** One message-local pass; contradictory native owners and duplicate calls stay unprojected. */
export function serializeCompletedSubagentOwners(parts: readonly PartState[]): string {
  const calls = new Map<string, { count: number; toolName: string; paused: boolean }>();
  const generations = new Map<string, string | null>();
  for (const part of parts) {
    if (part.type === 'tool-call') {
      calls.set(part.toolCallId, {
        count: (calls.get(part.toolCallId)?.count ?? 0) + 1,
        paused:
          part.result === undefined &&
          part.status.type === 'requires-action' &&
          isSubagentDelegationToolName(part.toolName),
        toolName: part.toolName,
      });
      continue;
    }
    const event = readAssistantRunEventDataPart(part);
    const callId = event?.metadata?.['parentToolCallId'];
    const generation = event?.metadata?.['parentRuntimeRunId'];
    if (typeof callId !== 'string' || typeof generation !== 'string' || !generation.trim()) {
      continue;
    }
    const previous = generations.get(callId);
    generations.set(callId, previous === undefined || previous === generation ? generation : null);
  }
  const owners: [string, string][] = [];
  for (const [callId, call] of calls) {
    const generation = generations.get(callId);
    if (call.count === 1 && call.paused && generation) {
      owners.push([callId, completedSubagentInvocationKey(generation, callId, call.toolName)]);
    }
  }
  return JSON.stringify(owners);
}

/** A terminal native invocation can settle its retained paused display copies. */
export function useCompletedSubagentCalls(): ReadonlySet<string> {
  const index = use(SubagentInvocationIndexContext);
  // Select by owner VALUE, not the parts array's identity: unrelated deltas do
  // not recreate subscriptions, while appended/replaced identity data stays live.
  const ownerKey = useAuiState((state) => serializeCompletedSubagentOwners(state.message.parts));
  const owners = useMemo(() => JSON.parse(ownerKey) as [string, string][], [ownerKey]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = owners.map(([, key]) => index?.subscribeCompleted(key, listener));
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
        owners.filter(([, key]) => index?.getCompletedSnapshot(key)).map(([call]) => call)
      ),
    [index, owners]
  );
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot]);
}
