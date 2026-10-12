import { useAuiState } from '@assistant-ui/react';
import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import { Button } from '@brainstrike/ui';
import { ChevronRight } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { useChangesReviewContext } from './changes-review-context';
import { useEditCheckpointEntries } from './edit-checkpoint-context';
import { selectFinishedRunId } from './run-verdict-control';

const EMPTY_ENTRIES: readonly AssistantEditCheckpointRecord[] = [];

/** Distinct files a run touched, keyed `(rootId, path)` — mirrors the house
 * identity convention (`changed-file-key`/`foldKey`) so two roots sharing a
 * relative path never collapse into one count. */
function countDistinctFiles(entries: readonly AssistantEditCheckpointRecord[]): number {
  const keys = new Set<string>();
  for (const entry of entries) {
    keys.add(`${entry.rootId} ${entry.path}`);
  }
  return keys.size;
}

/**
 * "Edited N files → Review" entry point into the Changes surface (BST-1114).
 * Renders null when: there is no `ChangesReviewProvider` binding (web, or a
 * desktop build without the `window.changes` bridge), this message's run has
 * not reached its terminal `run.finished` event yet (`selectFinishedRunId`
 * already anchors this to the ONE message that received that event — an
 * approval-split run's earlier legs never satisfy it), the active thread id
 * is unknown, or the run made zero journal entries — never a disabled stub,
 * and never "Edited 0 files".
 *
 * AVAILABILITY IS ALL JOURNAL ENTRIES FOR THE RUN, NOT REVERT ELIGIBILITY
 * (review finding, BST-1114 PR #2274): `useCheckpointTurnRevert`'s
 * `revertibleCount` excludes skipped/expired/already-reverted entries, so a
 * run whose only edits are non-revertible had NO message satisfying that
 * hook's ownership condition and this link could never appear — even though
 * the changeset resolver still surfaces those entries (honestly marked
 * non-revertible) and Review is exactly how the user reaches that expired-
 * content state. `useEditCheckpointEntries()` reads the SAME entries the
 * checkpoint provider supplies, unfiltered.
 *
 * The label counts DISTINCT FILES touched, not journal rows: a file written
 * twice in one run (e.g. write then string_replace) is one edited file, not
 * two "file edits".
 */
export function ChangesReviewLink({
  threadId,
}: {
  readonly threadId: string | undefined;
}): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const runId = useMemo(() => selectFinishedRunId(parts), [parts]);
  const entries = useEditCheckpointEntries();
  const context = useChangesReviewContext();

  const runEntries = useMemo(() => {
    if (!entries || runId === null) {
      return EMPTY_ENTRIES;
    }
    return entries.filter((entry) => entry.runId === runId);
  }, [entries, runId]);

  if (!(context && threadId && runId && runEntries.length > 0)) {
    return null;
  }

  const count = countDistinctFiles(runEntries);
  const label = `${count} file edit${count === 1 ? '' : 's'} from this turn`;

  return (
    <div className="mt-1 flex" data-testid="changes-review-footer">
      <Button
        className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
        data-testid="changes-review-link"
        onClick={() => context.openChangesForRun(runId, threadId)}
        size="sm"
        variant="ghost"
      >
        {label}
        <ChevronRight aria-hidden="true" className="size-3" />
        Review
      </Button>
    </div>
  );
}
