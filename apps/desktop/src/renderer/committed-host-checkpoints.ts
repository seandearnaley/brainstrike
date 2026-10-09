import type { HostClient } from '@brainstrike/agent-host/browser';
import { foldHostEditCheckpoints } from '@brainstrike/agent-host/edit-checkpoint-view';
import type { HostEditRevertOutcome, HostLogRow } from '@brainstrike/agent-host/protocol';
import { type CommittedThreadSession, foldHostRuns } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantCheckpointRevertResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import type { EditCheckpointContextValue } from '@brainstrike/assistant-ui';

/** Core refuses a revert while the thread has a run that has not finished. */
const ACTIVE_RUN_REFUSAL = 'Edits can be reverted once the current run finishes.';

function revertResult(
  entry: AssistantEditCheckpointRecord,
  outcome: HostEditRevertOutcome | undefined
): AssistantCheckpointRevertResult {
  if (!outcome) {
    throw new Error('The host revert reported no outcome for this edit');
  }
  if (outcome.status === 'reverted') {
    // The committed `workspace.edit.reverted` row re-folds this entry; this is the immediate reply.
    return { entry: { ...entry, revertedAt: new Date().toISOString() }, ok: true };
  }
  return {
    code: outcome.status === 'conflict' ? 'conflict' : 'not_revertible',
    id: entry.id,
    message: outcome.reason,
    ok: false,
  };
}

/**
 * The committed thread's edit checkpoints as the conversation's undo context:
 * a fold of committed rows, with every revert performed by Core through
 * `checkpoint/revert` and its outcome committed to the thread's log.
 */
export class CommittedHostCheckpoints {
  private rows: readonly HostLogRow[] | undefined;
  private value: EditCheckpointContextValue | undefined;

  constructor(
    private readonly client: Pick<HostClient, 'request'>,
    private readonly source: Pick<CommittedThreadSession, 'getSnapshot' | 'subscribe'>,
    private readonly threadId: string
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener);

  readonly getSnapshot = (): EditCheckpointContextValue => {
    const rows = this.source.getSnapshot().rows;
    if (!this.value || rows !== this.rows) {
      this.rows = rows;
      this.value = this.project(rows);
    }
    return this.value;
  };

  private project(rows: readonly HostLogRow[]): EditCheckpointContextValue {
    const { availabilityById, entries } = foldHostEditCheckpoints(rows);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const revert = (runId: string, force: boolean | undefined, entryId?: string) =>
      this.client.request('checkpoint/revert', {
        commandId: crypto.randomUUID(),
        ...(entryId === undefined ? {} : { entryId }),
        ...(force ? { force: true } : {}),
        runId,
        threadId: this.threadId,
      });
    return {
      availabilityById,
      entries,
      entriesByToolCallId: new Map(
        entries.flatMap((entry) => (entry.toolCallId ? [[entry.toolCallId, entry] as const] : []))
      ),
      revertEntry: async (id, options) => {
        const entry = byId.get(id);
        if (!entry) {
          return {
            code: 'not_found',
            id,
            message: 'This edit checkpoint was not found.',
            ok: false,
          };
        }
        const { outcomes } = await revert(entry.runId, options?.force, id);
        return revertResult(
          entry,
          outcomes.find((outcome) => outcome.entryId === id)
        );
      },
      revertRefusal: foldHostRuns(rows).some((run) => run.status === 'running')
        ? ACTIVE_RUN_REFUSAL
        : null,
      revertRun: async (runId, options) => {
        const { outcomes } = await revert(runId, options?.force);
        return {
          outcomes: outcomes.map((outcome) => {
            const entry = byId.get(outcome.entryId);
            if (!entry) {
              throw new Error('The host reverted an edit this view has not committed');
            }
            return revertResult(entry, outcome);
          }),
          runId,
        };
      },
    };
  }
}
