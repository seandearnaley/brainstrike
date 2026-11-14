/**
 * The provenance of a run's provider request (BST-1927), read from its
 * thread's committed log, and the part of it a compaction covers.
 */
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ModelMessage } from 'ai';
import {
  committedRowAddress,
  committedRunAncestors,
  committedRunIdentity,
} from './committed-identities.ts';
import { committedTranscript } from './committed-transcript.ts';
import type { HostCompactionCuts } from './compaction-segments.ts';
import { compactionCuts } from './context-compaction.ts';
import type { HostLogRow } from './protocol.ts';
import { isHostEarlierInput } from './turn-input.ts';

interface HostRunKey {
  readonly runId: string;
  readonly threadId: string;
}

/** A person's message an earlier run left unread: it stays with the turn ahead of its steps. */
function isEarlierInputRow(row: HostLogRow): boolean {
  return (
    row.event.type === 'model.messages' &&
    (row.event.messages as ModelMessage[]).some((message) => isHostEarlierInput(message))
  );
}

/** The run's branch: its ancestors and itself. */
function runBranch(rows: readonly HostLogRow[], run: HostRunKey): Set<string> {
  return new Set([...committedRunAncestors(rows, run.runId), run.runId]);
}

/**
 * Whether a row of a run `cuts` cut at a step is still sent: past its cut, in
 * a step its compactions kept, or a person's earlier message (BST-2531). A
 * row of a run cut at no step is.
 */
function sentStepRow(
  rows: readonly HostLogRow[],
  cuts: Pick<HostCompactionCuts, 'kept' | 'steps'>
): (runId: string, row: HostLogRow) => boolean {
  // Where each cut run's steps begin: a step ends where the next begins.
  const stepRows = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.event.type === 'model.step' && cuts.steps.has(row.event.runId)) {
      const steps = stepRows.get(row.event.runId) ?? new Map<number, number>();
      steps.set(row.event.stepNumber, row.seq);
      stepRows.set(row.event.runId, steps);
    }
  }
  return (runId, row) => {
    const cut = cuts.steps.get(runId);
    const steps = stepRows.get(runId);
    if (cut === undefined || !steps) {
      return true;
    }
    const begins = (step: number) =>
      step === 0 ? 0 : (steps.get(step) ?? Number.POSITIVE_INFINITY);
    return (
      row.seq >= begins(cut + 1) ||
      isEarlierInputRow(row) ||
      [...(cuts.kept.get(runId) ?? [])].some(
        (step) => row.seq >= begins(step) && row.seq < begins(step + 1)
      )
    );
  };
}

/**
 * The committed transcript of every turn the run's request sends: each earlier
 * turn of its branch that no committed compaction replaced, then its own, less
 * the steps a compaction replaced and did not keep (BST-2531). It borrows the exact committed
 * occurrences, so a known call is never lost to a turn that reuses its SDK ID.
 */
export function hostProviderHistory(
  rows: readonly HostLogRow[],
  run: HostRunKey
): MastraDBMessage[] {
  // In this thread only the selected branch is history: a sibling branch's
  // turns never enter the request.
  const branch = runBranch(rows, run);
  // A committed compaction of this branch replaces whole earlier turns and a
  // run's older steps (Core adds the note); each turn's user message stays.
  const cuts = compactionCuts(rows, branch);
  const sent = new Set([...branch].filter((runId) => !cuts.runs.has(runId)));
  const ids = new Set([...sent].map((runId) => committedRunIdentity(rows, runId).userMessageId));
  const sentRow = sentStepRow(rows, cuts);
  for (const row of rows) {
    if (row.threadId !== run.threadId || !('runId' in row.event) || !sent.has(row.event.runId)) {
      continue;
    }
    if (sentRow(row.event.runId, row)) {
      ids.add(committedRowAddress(row));
    }
  }
  return committedTranscript(rows).filter((message) => ids.has(message.id));
}

/**
 * The committed rows of the run's branch that `covered` takes out of its
 * requests (BST-2527): every row of a whole turn, and a cut run's rows its
 * requests no longer send. A kept step is still sent, so it is not among them.
 */
export function hostCompactedRows(
  rows: readonly HostLogRow[],
  run: HostRunKey,
  covered: HostCompactionCuts
): HostLogRow[] {
  const branch = runBranch(rows, run);
  const sentRow = sentStepRow(rows, covered);
  return rows.filter((row) => {
    if (row.threadId !== run.threadId || !('runId' in row.event)) {
      return false;
    }
    const { runId } = row.event;
    if (!branch.has(runId)) {
      return false;
    }
    return covered.runs.has(runId) || (covered.steps.has(runId) && !sentRow(runId, row));
  });
}
