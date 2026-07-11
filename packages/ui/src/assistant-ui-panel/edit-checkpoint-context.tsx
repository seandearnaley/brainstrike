import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { isRevertibleCaptureStatus } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, use, useMemo } from 'react';

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
  /** Every journal entry for the active thread, in apply order (ascending). */
  readonly entries: readonly AssistantEditCheckpointRecord[];
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
  const context = use(EditCheckpointContext);
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

/** The runs a message owns plus the true revert scope (whole run, not just this message). */
export interface TurnRevertScope {
  /** Every still-revertible entry across those runs — what `revertRun` will undo. */
  readonly revertibleCount: number;
  /** Distinct runs this message owns, newest-applied first. */
  readonly runIds: readonly string[];
}

/** Later apply order = larger occurredAt, id as tie-break (mirrors the DB order). */
function isLaterApply(a: AssistantEditCheckpointRecord, b: AssistantEditCheckpointRecord): boolean {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt > b.occurredAt;
  }
  return a.id > b.id;
}

/**
 * Given ONE assistant message's tool-call ids and ALL of the thread's journal
 * entries, decide which runs that message owns and the true revert scope.
 *
 * A live run splits across several assistant messages (each approval resume
 * starts a new message sharing the runId), yet `revertRun(runId)` undoes EVERY
 * still-revertible entry of the run. So the count must be the whole run's, not
 * this message's parts, and the footer must render once per run — on the run's
 * LAST leg. A message owns a run only when it contains that run's anchor: the
 * last-applied revertible entry that rendered as a tool call. Exactly one
 * message holds any given tool-call id, so exactly one message owns each run —
 * no duplicate footers, and the count equals what actually reverts (including a
 * run's `toolCallId: null` entries, which never render but still revert).
 *
 * Returns `null` when this message owns no run (no revertible edits, or it is
 * not any run's last leg) — capability gating, so the control renders nothing.
 *
 * Deliberate absent-until-terminal semantics for suspended runs: this reads only
 * committed journal `entries`, and an edit is journaled INSIDE the tool's
 * `execute` (see EDIT CHECKPOINT JOURNAL). A run suspended for approval, plan
 * submission, or askUser has not run its mutation tools yet, so it has no
 * entries and no footer — and a run mid-stream shows the footer only once its
 * anchor (last-applied leg) lands. The footer is therefore absent until the run
 * reaches its terminal edit, by design: we never offer "Revert all" for edits
 * that have not happened.
 */
export function selectTurnRevertScope(
  messageToolCallIds: readonly string[],
  entries: readonly AssistantEditCheckpointRecord[]
): TurnRevertScope | null {
  const messageIds = new Set(messageToolCallIds);
  const revertibleByRun = new Map<string, AssistantEditCheckpointRecord[]>();
  for (const entry of entries) {
    if (entry.revertedAt || !isRevertibleCaptureStatus(entry.captureStatus)) {
      continue;
    }
    const runEntries = revertibleByRun.get(entry.runId);
    if (runEntries) {
      runEntries.push(entry);
    } else {
      revertibleByRun.set(entry.runId, [entry]);
    }
  }

  const owned: { anchor: AssistantEditCheckpointRecord; count: number; runId: string }[] = [];
  for (const [runId, runEntries] of revertibleByRun) {
    let anchor: AssistantEditCheckpointRecord | null = null;
    let anchorId: string | null = null;
    for (const entry of runEntries) {
      if (entry.toolCallId && (!anchor || isLaterApply(entry, anchor))) {
        anchor = entry;
        anchorId = entry.toolCallId;
      }
    }
    if (anchor && anchorId && messageIds.has(anchorId)) {
      owned.push({ anchor, count: runEntries.length, runId });
    }
  }

  if (owned.length === 0) {
    return null;
  }
  owned.sort((a, b) => (isLaterApply(a.anchor, b.anchor) ? -1 : 1));
  return {
    revertibleCount: owned.reduce((total, run) => total + run.count, 0),
    runIds: owned.map((run) => run.runId),
  };
}

/**
 * Turn-level revert binding for one assistant message's tool calls, or `null`
 * when there is no provider (web / not desktop) or the message owns no run —
 * capability gating, so the turn-level control renders nothing. `revert` runs
 * each owned run sequentially, newest first (a shared file edited by two runs
 * must be reverted in reverse order — `Promise.all` cannot guarantee it).
 */
export function useCheckpointTurnRevert(toolCallIds: readonly string[]): {
  revertibleCount: number;
  revert: (options?: { force?: boolean }) => Promise<readonly AssistantCheckpointRevertRunResult[]>;
} | null {
  const context = use(EditCheckpointContext);
  const idsKey = toolCallIds.join('\n');
  return useMemo(() => {
    if (!context) {
      return null;
    }
    const ids = idsKey === '' ? [] : idsKey.split('\n');
    const scope = selectTurnRevertScope(ids, context.entries);
    if (!scope) {
      return null;
    }
    const { revertRun } = context;
    return {
      revert: async (options) => {
        const results: AssistantCheckpointRevertRunResult[] = [];
        for (const runId of scope.runIds) {
          results.push(await revertRun(runId, options));
        }
        return results;
      },
      revertibleCount: scope.revertibleCount,
    };
    // idsKey is a stable serialization of toolCallIds; depend on it, not the array identity.
  }, [context, idsKey]);
}
