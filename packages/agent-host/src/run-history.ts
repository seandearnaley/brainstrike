/**
 * The provenance of a run's provider request (BST-1927), read from its
 * thread's committed log.
 */
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ModelMessage } from 'ai';
import {
  committedRowAddress,
  committedRunAncestors,
  committedRunIdentity,
} from './committed-identities.ts';
import { committedTranscript } from './committed-transcript.ts';
import { compactionCuts } from './context-compaction.ts';
import type { HostLogRow } from './protocol.ts';
import { isHostEarlierInput } from './turn-input.ts';

/** A person's message an earlier run left unread: it stays with the turn ahead of its steps. */
function isEarlierInputRow(row: HostLogRow): boolean {
  return (
    row.event.type === 'model.messages' &&
    (row.event.messages as ModelMessage[]).some((message) => isHostEarlierInput(message))
  );
}

/**
 * The committed transcript of every turn the run's request sends: each earlier
 * turn of its branch that no committed compaction replaced, then its own, less
 * the steps a compaction replaced and did not keep (BST-2531). It borrows the exact committed
 * occurrences, so a known call is never lost to a turn that reuses its SDK ID.
 */
export function hostProviderHistory(
  rows: readonly HostLogRow[],
  run: { readonly runId: string; readonly threadId: string }
): MastraDBMessage[] {
  // In this thread only the selected branch is history: a sibling branch's
  // turns never enter the request.
  const branch = new Set([...committedRunAncestors(rows, run.runId), run.runId]);
  // A committed compaction of this branch replaces whole earlier turns and a
  // run's older steps (Core adds the note); each turn's user message stays.
  const cuts = compactionCuts(rows, branch);
  const sent = new Set([...branch].filter((runId) => !cuts.runs.has(runId)));
  const ids = new Set([...sent].map((runId) => committedRunIdentity(rows, runId).userMessageId));
  // Where each cut run's steps begin: a step ends where the next begins.
  const stepRows = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.event.type === 'model.step' && cuts.steps.has(row.event.runId)) {
      const steps = stepRows.get(row.event.runId) ?? new Map<number, number>();
      steps.set(row.event.stepNumber, row.seq);
      stepRows.set(row.event.runId, steps);
    }
  }
  /** Whether a cut run's row is still sent: past its cut, in a kept step, or a person's earlier message. */
  const sentRow = (runId: string, row: HostLogRow): boolean => {
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
