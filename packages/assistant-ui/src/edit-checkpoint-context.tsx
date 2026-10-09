import type {
  AssistantCheckpointRevertResult,
  AssistantCheckpointRevertRunResult,
  AssistantCheckpointUndoAvailability,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { isRevertibleCaptureStatus, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, use, useMemo } from 'react';

/**
 * The four agent mutation tools whose tool cards can carry a Revert control. Kept
 * in the UI layer so `ToolFallback` can gate the button without importing the
 * desktop tool registry.
 */
export const REVERTIBLE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
]);

export interface EditCheckpointContextValue {
  /**
   * Snapshot-availability per journal entry id (BST-1164 T4): whether the
   * turn-start snapshot the undo engine restores from exists for that entry,
   * with the user-facing reason when it does not. An entry MISSING from the
   * map is treated as unavailable (fail-safe: the control renders disabled
   * with a generic reason, never an enabled button that refuses on click).
   */
  readonly availabilityById: ReadonlyMap<string, AssistantCheckpointUndoAvailability>;
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
   * Why every revert is refused right now (a host thread's active run), or
   * null. Each Revert control renders disabled with this reason rather than
   * offering a click the owner would refuse.
   */
  readonly revertRefusal: string | null;
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
 * Fail-safe read of an entry's snapshot availability: an id the map does not
 * know is UNAVAILABLE with a generic reason, never silently enabled. The
 * data layer populates the map for every listed entry, so the fallback only
 * shows on a data-layer failure — which is exactly when a click would fail.
 */
export function availabilityForEntry(
  availabilityById: ReadonlyMap<string, AssistantCheckpointUndoAvailability>,
  entryId: string
): AssistantCheckpointUndoAvailability {
  return (
    availabilityById.get(entryId) ?? {
      reason: 'Snapshot availability could not be determined for this edit.',
      restorable: false,
    }
  );
}

/**
 * The journal entry for a given tool call plus a bound revert action and its
 * snapshot availability, or `null` when there is no provider (web / not
 * desktop) or no journal entry yet for this call. A `null` return means
 * "render no Revert control" — capability gating, not a disabled stub.
 */
export function useCheckpointForToolCall(toolCallId: string): {
  availability: AssistantCheckpointUndoAvailability;
  entry: AssistantEditCheckpointRecord;
  /** Non-null while reverts are refused: render Revert disabled with this reason. */
  refusal: string | null;
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
    availability: availabilityForEntry(context.availabilityById, entry.id),
    entry,
    refusal: context.revertRefusal,
    revert: (options) => context.revertEntry(entry.id, options),
  };
}

/**
 * Every journal entry for the active thread, or `null` when there is no
 * provider (web / not desktop) — capability gating, not an empty list. Unlike
 * `useCheckpointTurnRevert`, this is NOT filtered by revertibility/expiry/
 * message ownership: a review entry point needs to know a run genuinely has
 * journal entries, not whether they are still revertible (an expired or
 * already-reverted entry still means the run touched files, and the
 * changeset resolver still surfaces it).
 */
export function useEditCheckpointEntries(): readonly AssistantEditCheckpointRecord[] | null {
  const context = use(EditCheckpointContext);
  return context?.entries ?? null;
}

/** The runs a message owns plus the true revert scope (whole run, not just this message). */
export interface TurnRevertScope {
  /** Every still-revertible entry across those runs — what `revertRun` will undo. */
  readonly revertibleCount: number;
  /** Distinct runs this message owns, newest-applied first. */
  readonly runIds: readonly string[];
  /**
   * When every owned entry is snapshot-unavailable (`revertibleCount: 0`),
   * the first unavailable reason — the disabled footer's visible copy
   * (BST-1164 T4: pre-engine turns render a disabled state with the reason,
   * never a silently absent control). Null while anything is revertible.
   */
  readonly unavailableReason: string | null;
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
  entries: readonly AssistantEditCheckpointRecord[],
  availabilityById: ReadonlyMap<string, AssistantCheckpointUndoAvailability>
): TurnRevertScope | null {
  const messageIds = new Set(messageToolCallIds);
  const revertibleByRun = groupRevertibleEntriesByRun(entries);

  const owned: OwnedRunScope[] = [];
  for (const [runId, runEntries] of revertibleByRun) {
    const anchor = findRunAnchor(runEntries);
    if (!(anchor?.toolCallId && messageIds.has(anchor.toolCallId))) {
      continue;
    }
    // Snapshot availability decides what `revertRun` can actually restore; a
    // run whose entries are all unavailable stays OWNED (its footer renders a
    // visible disabled state) but contributes nothing to the count.
    owned.push({ anchor, runId, ...tallyRunAvailability(runEntries, availabilityById) });
  }

  if (owned.length === 0) {
    return null;
  }
  owned.sort((a, b) => (isLaterApply(a.anchor, b.anchor) ? -1 : 1));
  const revertibleCount = owned.reduce((total, run) => total + run.availableCount, 0);
  return {
    revertibleCount,
    // Only runs with something restorable are worth invoking.
    runIds: owned.filter((run) => run.availableCount > 0).map((run) => run.runId),
    unavailableReason:
      revertibleCount === 0
        ? (owned.find((run) => run.firstUnavailableReason !== null)?.firstUnavailableReason ??
          'These edits cannot be restored.')
        : null,
  };
}

interface OwnedRunScope {
  readonly anchor: AssistantEditCheckpointRecord;
  readonly availableCount: number;
  readonly firstUnavailableReason: string | null;
  readonly runId: string;
}

function groupRevertibleEntriesByRun(
  entries: readonly AssistantEditCheckpointRecord[]
): ReadonlyMap<string, readonly AssistantEditCheckpointRecord[]> {
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
  return revertibleByRun;
}

/** The run's last-applied entry that rendered as a tool call, or null. */
function findRunAnchor(
  runEntries: readonly AssistantEditCheckpointRecord[]
): AssistantEditCheckpointRecord | null {
  let anchor: AssistantEditCheckpointRecord | null = null;
  for (const entry of runEntries) {
    if (entry.toolCallId && (!anchor || isLaterApply(entry, anchor))) {
      anchor = entry;
    }
  }
  return anchor;
}

function tallyRunAvailability(
  runEntries: readonly AssistantEditCheckpointRecord[],
  availabilityById: ReadonlyMap<string, AssistantCheckpointUndoAvailability>
): { availableCount: number; firstUnavailableReason: string | null } {
  let availableCount = 0;
  let firstUnavailableReason: string | null = null;
  for (const entry of runEntries) {
    const availability = availabilityForEntry(availabilityById, entry.id);
    if (availability.restorable) {
      availableCount += 1;
    } else {
      firstUnavailableReason = firstUnavailableReason ?? availability.reason;
    }
  }
  return { availableCount, firstUnavailableReason };
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
  /** Non-null while reverts are refused: render the control disabled with this reason. */
  refusal: string | null;
  revert: (options?: { force?: boolean }) => Promise<readonly AssistantCheckpointRevertRunResult[]>;
  /** Non-null when nothing is restorable — render disabled with this reason. */
  unavailableReason: string | null;
} | null {
  const context = use(EditCheckpointContext);
  const idsKey = toolCallIds.join('\n');
  return useMemo(() => {
    if (!context) {
      return null;
    }
    const ids = idsKey === '' ? [] : idsKey.split('\n');
    const scope = selectTurnRevertScope(ids, context.entries, context.availabilityById);
    if (!scope) {
      return null;
    }
    const { revertRefusal, revertRun } = context;
    return {
      refusal: revertRefusal,
      revert: async (options) => {
        const results: AssistantCheckpointRevertRunResult[] = [];
        for (const runId of scope.runIds) {
          results.push(await revertRun(runId, options));
        }
        return results;
      },
      revertibleCount: scope.revertibleCount,
      unavailableReason: scope.unavailableReason,
    };
    // idsKey is a stable serialization of toolCallIds; depend on it, not the array identity.
  }, [context, idsKey]);
}
