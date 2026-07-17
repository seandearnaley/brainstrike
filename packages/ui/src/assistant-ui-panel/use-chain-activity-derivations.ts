import type { ManageTaskListResult } from '@brainstrike/assistant-contract';
import { useMemo } from 'react';
import { deriveTaskListFromParts } from './derive-task-list';
import { createShellOutputAccumulator, type ShellOutputAccumulation } from './shell-output-parts';
import { runEventsSpanMs, summarizeToolActivity, type ToolActivitySummary } from './tool-activity';
import { collectToolDurations } from './tool-durations';
import { useStableRecord } from './use-stable-record';

export interface ChainActivityDerivations {
  readonly activityFallbackMs: number | undefined;
  readonly shellOutputs: Record<string, ShellOutputAccumulation>;
  readonly taskList: ManageTaskListResult | null;
  readonly toolActivity: ToolActivitySummary;
  readonly toolDurations: Record<string, number>;
}

/**
 * The chain-of-thought's per-turn derivations from `message.parts`, with the
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
export function useChainActivityDerivations(
  messageParts: readonly unknown[],
  messageId: string
): ChainActivityDerivations {
  const toolActivity = useMemo(() => summarizeToolActivity(messageParts), [messageParts]);
  const activityFallbackMs = useMemo(() => runEventsSpanMs(messageParts), [messageParts]);
  const toolDurations = useStableRecord(
    useMemo(() => collectToolDurations(messageParts), [messageParts])
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageId intentionally resets the stateful accumulator per message
  const accumulateShellOutputs = useMemo(() => createShellOutputAccumulator(), [messageId]);
  const shellOutputs = useMemo(
    () => accumulateShellOutputs(messageParts),
    [accumulateShellOutputs, messageParts]
  );
  const taskList = useMemo(() => deriveTaskListFromParts(messageParts), [messageParts]);

  return { activityFallbackMs, shellOutputs, taskList, toolActivity, toolDurations };
}
