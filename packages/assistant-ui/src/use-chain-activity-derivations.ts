import {
  type ManageTaskListResult,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import { useMemo } from 'react';
import { deriveTaskListFromParts } from './derive-task-list';
import { createShellOutputAccumulator, type ShellOutputAccumulation } from './shell-output-parts';
import { isToolCallPart, runEventsSpanMs } from './tool-activity';
import { collectToolDurations } from './tool-durations';
import { useStableRecord } from './use-stable-record';

export interface ChainActivityDerivations {
  readonly activityFallbackMs: number | undefined;
  readonly shellOutputs: Record<string, ShellOutputAccumulation>;
  readonly taskList: ManageTaskListResult | null;
  readonly toolDurations: Record<string, number>;
}

/**
 * Group-local elapsed time, plus message-wide call-id lookups with the
 * context-value stability this hot path needs: `messageParts` gets a new
 * identity on EVERY streamed chunk, so raw per-chunk recomputations would hand
 * ToolDurationProvider/ShellOutputProvider fresh objects each chunk and
 * re-render every tool card in the turn (each one a context consumer) for
 * unrelated text deltas.
 *
 * - durations: recomputed per chunk but value-stable via useStableRecord
 *   (identity only changes when a tool actually finishes).
 * - shell outputs: incremental accumulator, O(new parts) per update, same
 *   record identity unless a shell slice actually arrived — keyed by message
 *   id so a thread/message switch resets it.
 */
/**
 * Current-group tool-call ids in a single pass. The previous
 * `filter(isToolCallPart).map(...)` chain allocated two intermediate arrays on
 * every streamed chunk along this hot path; one loop keeps the memoized
 * derivation allocation-flat. Only string ids are collected — the elapsed
 * lookup below probes string ids only, so membership is unchanged.
 */
export function collectGroupToolCallIds(groupParts: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const part of groupParts) {
    if (!isToolCallPart(part)) {
      continue;
    }
    const toolCallId = part['toolCallId'];
    if (typeof toolCallId === 'string') {
      ids.add(toolCallId);
    }
  }
  return ids;
}

export function useChainActivityDerivations(
  messageParts: readonly unknown[],
  messageId: string,
  groupParts: readonly unknown[]
): ChainActivityDerivations {
  const activityFallbackMs = useMemo(() => {
    const ids = collectGroupToolCallIds(groupParts);
    return runEventsSpanMs(
      messageParts.filter((part) => {
        const event = readAssistantRunEventDataPart(part);
        const id = event?.metadata?.['toolCallId'];
        return typeof id === 'string' && ids.has(id);
      })
    );
  }, [messageParts, groupParts]);
  const toolDurations = useStableRecord(
    useMemo(() => collectToolDurations(messageParts), [messageParts])
  );
  const accumulateShellOutputs = useMemo(() => createShellOutputAccumulator(), [messageId]);
  const shellOutputs = useMemo(
    () => accumulateShellOutputs(messageParts),
    [accumulateShellOutputs, messageParts]
  );
  const taskList = useMemo(() => deriveTaskListFromParts(messageParts), [messageParts]);

  return { activityFallbackMs, shellOutputs, taskList, toolDurations };
}
