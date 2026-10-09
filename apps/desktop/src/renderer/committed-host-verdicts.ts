import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { projectRunVerdicts } from '@brainstrike/agent-host/run-verdicts';
import type { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import type { RunVerdictContextValue, RunVerdictValue } from '@brainstrike/assistant-ui';

/**
 * The committed thread's run verdicts as the conversation's verdict context: a
 * fold of committed `run.verdict` rows with the host's own precedence (a user
 * verdict outranks a hook's or a revert's), each new choice recorded through
 * `run/verdict`, so it survives a reload.
 */
export class CommittedHostVerdicts {
  private rows: readonly HostLogRow[] | undefined;
  private value: RunVerdictContextValue | undefined;

  constructor(
    private readonly client: HostClient,
    private readonly source: CommittedThreadSession,
    private readonly threadId: string
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener);

  readonly getSnapshot = (): RunVerdictContextValue => {
    const rows = this.source.getSnapshot().rows;
    if (!this.value || rows !== this.rows) {
      this.rows = rows;
      this.value = { committed: projectRunVerdicts(rows), recordVerdict: this.record };
    }
    return this.value;
  };

  private readonly record = async (runId: string, verdict: RunVerdictValue): Promise<void> => {
    await this.client.request('run/verdict', {
      commandId: crypto.randomUUID(),
      runId,
      source: 'user',
      threadId: this.threadId,
      verdict,
    });
  };
}
