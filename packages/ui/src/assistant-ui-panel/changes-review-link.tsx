import { useAuiState } from '@assistant-ui/react';
import { ChevronRight } from 'lucide-react';
import { type ReactElement, useMemo } from 'react';
import { Button } from '../button';
import { useChangesReviewContext } from './changes-review-context';
import { collectMutationToolCallIds } from './checkpoint-turn-revert';
import { useCheckpointTurnRevert } from './edit-checkpoint-context';
import { selectFinishedRunId } from './run-verdict-control';

/**
 * "Edited N files → Review" entry point into the Changes surface (BST-1114).
 * Renders null when: there is no `ChangesReviewProvider` binding (web, or a
 * desktop build without the `window.changes` bridge), this message's run has
 * not reached its terminal `run.finished` event yet (mirrors
 * `RunVerdictControl`'s `selectFinishedRunId` gating), the active thread id
 * is unknown, or the turn made zero still-revertible file edits — never a
 * disabled stub, and never "Edited 0 files".
 *
 * The count IS `useCheckpointTurnRevert`'s `revertibleCount`: the number of
 * still-revertible edit-checkpoint journal entries across the run(s) this
 * message owns — one per still-revertible file mutation. That is a
 * different fact from "files in the changeset" (a file the assistant edited
 * that the user then manually reverted on disk, or that changed again since,
 * drops out of this count) and a different fact from a diff line-count stat
 * (the journal records no additions/deletions). The label says "file edits",
 * matching exactly what the number measures — never "files".
 */
export function ChangesReviewLink({
  threadId,
}: {
  readonly threadId: string | undefined;
}): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const toolCallIds = useMemo(() => collectMutationToolCallIds(parts), [parts]);
  const runId = useMemo(() => selectFinishedRunId(parts), [parts]);
  const turn = useCheckpointTurnRevert(toolCallIds);
  const context = useChangesReviewContext();

  if (!(context && threadId && runId && turn && turn.revertibleCount > 0)) {
    return null;
  }

  const count = turn.revertibleCount;
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
