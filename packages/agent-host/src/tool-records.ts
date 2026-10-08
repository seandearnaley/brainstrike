import type { BlobContent } from '@brainstrike/state-store';
import type { HostToolContext } from './ports.js';
import type { HostEvent, HostLogRow } from './protocol.js';
import { HostToolStates } from './tool-state.js';
import { HostWorkspaceEdits, hostEditScope } from './workspace-edits.js';

/** Core's per-thread tool records: workspace edit checkpoints and tool state, folded from the log. */
export class HostToolRecords {
  readonly edits = new HostWorkspaceEdits();
  private readonly states = new HostToolStates();

  fold(row: HostLogRow): void {
    this.edits.fold(row);
    this.states.fold(row);
  }

  forgetThread(threadId: string): void {
    this.edits.forgetThread(threadId);
    this.states.forgetThread(threadId);
  }

  /** The Core-owned edit and state capabilities of one dispatched execution. */
  context(
    run: Parameters<typeof hostEditScope>[0],
    action: Parameters<typeof hostEditScope>[1],
    retired: () => boolean,
    append: (events: readonly HostEvent[], blobs?: readonly BlobContent[]) => Promise<unknown>
  ): Required<Pick<HostToolContext, 'edits' | 'state'>> {
    const scope = hostEditScope(run, action, retired);
    return {
      edits: this.edits.tracker(scope, (event, blobs) => append([event], blobs)),
      state: this.states.capability(scope, (event) => append([event])),
    };
  }
}
