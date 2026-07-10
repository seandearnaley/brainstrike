import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { isRevertibleCaptureStatus } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

/**
 * The four agent mutation tools whose tool cards can carry a Revert control. Kept
 * in the UI layer so `ToolFallback` can gate the button without importing the
 * desktop tool registry.
 */
export const REVERTIBLE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'brainstrike.deleteWorkspaceFile',
  'brainstrike.renameWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.writeWorkspaceFile',
]);

export interface EditCheckpointContextValue {
  /** Journal entries for the active thread, keyed by the tool call that made them. */
  readonly entriesByToolCallId: ReadonlyMap<string, AssistantEditCheckpointRecord>;
  /** Revert one edit. `force` skips the conflict check ("Revert anyway"). */
  readonly revertEntry: (
    id: string,
    options?: { force?: boolean }
  ) => Promise<AssistantCheckpointRevertResult>;
  /**
   * Revert every non-reverted entry recorded for a run (one assistant turn), in
   * reverse apply order. `force` skips the per-file conflict check. Partial
   * success is honest — one conflicting file never aborts the rest.
   */
  readonly revertRun: (
    runId: string,
    options?: { force?: boolean }
  ) => Promise<AssistantCheckpointRevertRunResult>;
}

const EditCheckpointContext = createContext<EditCheckpointContextValue | null>(null);

export function EditCheckpointProvider({
  value,
  children,
}: {
  value: EditCheckpointContextValue | null;
  children: ReactNode;
}) {
  return <EditCheckpointContext.Provider value={value}>{children}</EditCheckpointContext.Provider>;
}

/**
 * The journal entry for a given tool call plus a bound revert action, or `null`
 * when there is no provider (web / not desktop) or no journal entry yet for this
 * call. A `null` return means "render no Revert control" — capability gating, not
 * a disabled stub.
 */
export function useCheckpointForToolCall(toolCallId: string): {
  entry: AssistantEditCheckpointRecord;
  revert: (options?: { force?: boolean }) => Promise<AssistantCheckpointRevertResult>;
} | null {
  const context = useContext(EditCheckpointContext);
  if (!context) {
    return null;
  }
  const entry = context.entriesByToolCallId.get(toolCallId);
  if (!entry) {
    return null;
  }
  return {
    entry,
    revert: (options) => context.revertEntry(entry.id, options),
  };
}

/** The revertible, not-yet-reverted entries for a turn plus the distinct runs they span. */
export interface TurnRevertSelection {
  readonly entries: readonly AssistantEditCheckpointRecord[];
  readonly runIds: readonly string[];
}

/**
 * From the tool calls of one assistant turn, select the journal entries that can
 * still be reverted (revertible capture status, not already reverted) and the
 * distinct run ids they belong to. Pure so the turn-level control's gating can be
 * tested without React.
 */
export function selectRevertibleTurnEntries(
  toolCallIds: readonly string[],
  entriesByToolCallId: ReadonlyMap<string, AssistantEditCheckpointRecord>
): TurnRevertSelection {
  const entries: AssistantEditCheckpointRecord[] = [];
  const runIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const toolCallId of toolCallIds) {
    const entry = entriesByToolCallId.get(toolCallId);
    if (!entry || entry.revertedAt || !isRevertibleCaptureStatus(entry.captureStatus)) {
      continue;
    }
    entries.push(entry);
    if (!seenRunIds.has(entry.runId)) {
      seenRunIds.add(entry.runId);
      runIds.push(entry.runId);
    }
  }
  return { entries, runIds };
}

/**
 * Turn-level revert binding for a set of tool calls, or `null` when there is no
 * provider (web / not desktop) or the turn has no revertible edits — capability
 * gating, so the turn-level control renders nothing. `revert` runs every distinct
 * run the turn spans (normally one) and returns their per-run outcomes.
 */
export function useCheckpointTurnRevert(toolCallIds: readonly string[]): {
  revertibleCount: number;
  revert: (options?: { force?: boolean }) => Promise<readonly AssistantCheckpointRevertRunResult[]>;
} | null {
  const context = useContext(EditCheckpointContext);
  const idsKey = toolCallIds.join('\n');
  return useMemo(() => {
    if (!context) {
      return null;
    }
    const ids = idsKey === '' ? [] : idsKey.split('\n');
    const selection = selectRevertibleTurnEntries(ids, context.entriesByToolCallId);
    if (selection.entries.length === 0) {
      return null;
    }
    return {
      revert: (options) =>
        Promise.all(selection.runIds.map((runId) => context.revertRun(runId, options))),
      revertibleCount: selection.entries.length,
    };
    // idsKey is a stable serialization of toolCallIds; depend on it, not the array identity.
  }, [context, idsKey]);
}
