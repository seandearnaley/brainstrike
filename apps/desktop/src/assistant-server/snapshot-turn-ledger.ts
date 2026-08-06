/**
 * Pure turn-bracket derivation over the `brainstrike_workspace_snapshots`
 * ledger (BST-1164 T2).
 *
 * A TURN in the ledger is a bracket: one contiguous group of `turn-start`
 * rows (one per workspace root, all stamped with the SAME `run_id` — the
 * turn's FIRST leg) followed by everything up to the next `turn-start`
 * group. `turn-end` rows inside that span close the bracket (their `run_id`
 * is the turn's LAST leg — a turn is not a run; approval/suspend resumes
 * mint additional run rows that appear on NO snapshot row). `pre-revert`
 * rows (T3) are ignored here: they are restore bookkeeping, not turn
 * boundaries.
 *
 * Ordering contract: rows MUST be `snapshotsForThread` order
 * (`created_at ASC, id ASC` — the repository's monotonic uuidv7 ids make the
 * tiebreak mint order). Timestamps are the repository's `::text` reads and
 * are only ever compared LEXICOGRAPHICALLY against other `::text` timestamps
 * from the same database session (identical rendering ⇒ lexicographic order
 * is chronological order; never route them through a JS `Date`, which
 * truncates the microsecond fraction).
 *
 * Failed captures (sentinel oid rows) participate in bracketing exactly like
 * real captures — a failed capture is a recorded fact about the turn, and
 * dropping it would silently un-mark the failure. Resolution decides what a
 * sentinel MEANS; this module only groups rows.
 */
import type { WorkspaceSnapshotRow } from './snapshot-repository';

export interface SnapshotTurnBracket {
  /** Per-root turn-end rows (last one wins per root), keyed by rootId. */
  readonly endByRoot: ReadonlyMap<string, WorkspaceSnapshotRow>;
  /** The turn's LAST leg run id, or null while no turn-end row exists. */
  readonly endRunId: string | null;
  /** Per-root turn-start rows, keyed by rootId. */
  readonly startByRoot: ReadonlyMap<string, WorkspaceSnapshotRow>;
  /** `created_at` of the bracket's first turn-start row (`::text`). */
  readonly startCreatedAt: string;
  /** The turn's FIRST leg run id (null only for a degenerate null-run row). */
  readonly startRunId: string | null;
}

interface MutableBracket {
  endByRoot: Map<string, WorkspaceSnapshotRow>;
  endRunId: string | null;
  startByRoot: Map<string, WorkspaceSnapshotRow>;
  startCreatedAt: string;
  startRunId: string | null;
}

function freeze(bracket: MutableBracket): SnapshotTurnBracket {
  return {
    endByRoot: bracket.endByRoot,
    endRunId: bracket.endRunId,
    startByRoot: bracket.startByRoot,
    startCreatedAt: bracket.startCreatedAt,
    startRunId: bracket.startRunId,
  };
}

/**
 * Group a thread's snapshot rows into turn brackets, oldest-first.
 *
 * A new bracket opens at a `turn-start` row when there is no current
 * bracket, when the current bracket already has end rows, or when the row's
 * `run_id` differs from the current bracket's start run id (the
 * process-death edge: a turn that never recorded its end is still separated
 * from the next turn by the first leg's distinct run id). An orphan
 * `turn-end` row with no preceding bracket opens a start-less bracket
 * (`startByRoot` empty) so resolution reports it as a missing start rather
 * than silently dropping the rows.
 */
export function resolveSnapshotTurnBrackets(
  rows: readonly WorkspaceSnapshotRow[]
): readonly SnapshotTurnBracket[] {
  const brackets: MutableBracket[] = [];
  let current: MutableBracket | null = null;

  for (const row of rows) {
    if (row.kind === 'pre-revert') {
      continue;
    }
    if (row.kind === 'turn-start') {
      const needsNewBracket =
        current === null || current.endRunId !== null || current.startRunId !== row.runId;
      if (needsNewBracket) {
        current = {
          endByRoot: new Map(),
          endRunId: null,
          startByRoot: new Map(),
          startCreatedAt: row.createdAt,
          startRunId: row.runId,
        };
        brackets.push(current);
      }
      current?.startByRoot.set(row.rootId, row);
      continue;
    }
    // turn-end
    if (current === null) {
      current = {
        endByRoot: new Map(),
        endRunId: null,
        startByRoot: new Map(),
        startCreatedAt: row.createdAt,
        startRunId: null,
      };
      brackets.push(current);
    }
    current.endByRoot.set(row.rootId, row);
    current.endRunId = row.runId;
  }

  return brackets.map(freeze);
}

/**
 * The bracket whose start run id equals `runId`, else the one whose end run
 * id does, or null. The START match is checked across ALL brackets first —
 * never with equal priority in one oldest-first scan: ledgers written before
 * the abandoned-turn close fix stamped the INCOMING leg's id on the old
 * turn's `turn-end` rows, making one id both turn N's `endRunId` and turn
 * N+1's `startRunId`. An equal-priority scan resolved that id BACKWARDS into
 * the abandoned turn — and checkpoint undo derives its restore baseline from
 * this lookup, so the backwards match was a wrong-baseline destructive
 * restore, not a display bug.
 */
export function findBracketByRunId(
  brackets: readonly SnapshotTurnBracket[],
  runId: string
): SnapshotTurnBracket | null {
  return (
    brackets.find((bracket) => bracket.startRunId === runId) ??
    brackets.find((bracket) => bracket.endRunId === runId) ??
    null
  );
}

/**
 * Locate the bracket containing a run that appears on NO snapshot row (a
 * mid-turn resume leg), from the run row's own timestamps. The turn-start
 * snapshot of the run's turn is always captured BEFORE the run completes
 * (first leg: request handling precedes completion; resume leg: the start
 * predates the leg entirely), and the NEXT turn's start is always captured
 * after this run's terminal status write — so the containing bracket is the
 * LAST one whose `startCreatedAt` precedes the run's completion, provided
 * the run did not start after that bracket's successor opened. All
 * comparisons are lexicographic over same-session `::text` timestamps (see
 * the module doc comment).
 *
 * `completedAt: null` (in-flight or never-finished run) matches the last
 * bracket the run could belong to.
 */
export function findBracketByRunAnchor(
  brackets: readonly SnapshotTurnBracket[],
  anchor: { readonly completedAt: string | null; readonly startedAt: string }
): SnapshotTurnBracket | null {
  for (let index = brackets.length - 1; index >= 0; index -= 1) {
    const bracket = brackets[index];
    if (!bracket) {
      continue;
    }
    if (anchor.completedAt !== null && bracket.startCreatedAt >= anchor.completedAt) {
      continue;
    }
    const successor = brackets[index + 1];
    if (successor && anchor.startedAt >= successor.startCreatedAt) {
      // The run started after the next turn opened — it cannot belong here.
      return null;
    }
    return bracket;
  }
  return null;
}
