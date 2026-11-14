/**
 * The provenance of a run's provider request (BST-1927), read from its
 * thread's committed log.
 */
import type { MastraDBMessage } from '@mastra/core/agent';
import {
  committedRowAddress,
  committedRunAncestors,
  committedRunIdentity,
} from './committed-identities.ts';
import { committedTranscript } from './committed-transcript.ts';
import { compactedRunIds } from './context-compaction.ts';
import type { HostLogRow } from './protocol.ts';

/**
 * The committed transcript of every turn the run's request sends: each earlier
 * turn of its branch that no committed compaction replaced, then its own. It
 * borrows the exact committed occurrences, so a known call is never lost to a
 * turn that reuses its SDK ID.
 */
export function hostProviderHistory(
  rows: readonly HostLogRow[],
  run: { readonly runId: string; readonly threadId: string }
): MastraDBMessage[] {
  // In this thread only the selected branch is history: a sibling branch's
  // turns never enter the request.
  const path = new Set(committedRunAncestors(rows, run.runId));
  // A committed compaction of this branch replaces whole earlier turns (Core adds the note).
  const compacted = compactedRunIds(rows, path);
  const sent = new Set([...path].filter((runId) => !compacted.has(runId)));
  sent.add(run.runId);
  const ids = new Set([...sent].map((runId) => committedRunIdentity(rows, runId).userMessageId));
  for (const row of rows) {
    if (row.threadId === run.threadId && 'runId' in row.event && sent.has(row.event.runId)) {
      ids.add(committedRowAddress(row));
    }
  }
  return committedTranscript(rows).filter((message) => ids.has(message.id));
}
