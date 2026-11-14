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
 * the steps a compaction replaced (BST-2531). It borrows the exact committed
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
  // A step ends where the next begins: a run's request resumes at the step after its cut.
  const resumesAt = new Map(
    rows.flatMap((row) =>
      row.event.type === 'model.step' &&
      cuts.steps.get(row.event.runId) === row.event.stepNumber - 1
        ? [[row.event.runId, row.seq] as const]
        : []
    )
  );
  for (const row of rows) {
    if (row.threadId !== run.threadId || !('runId' in row.event) || !sent.has(row.event.runId)) {
      continue;
    }
    if (row.seq >= (resumesAt.get(row.event.runId) ?? 0) || isEarlierInputRow(row)) {
      ids.add(committedRowAddress(row));
    }
  }
  return committedTranscript(rows).filter((message) => ids.has(message.id));
}
