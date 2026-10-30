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

  private readonly client: HostClient;
  private readonly source: CommittedThreadSession;
  private readonly threadId: string;

  constructor(client: HostClient, source: CommittedThreadSession, threadId: string) {
    this.client = client;
    this.source = source;
    this.threadId = threadId;
  }

  readonly subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener);

  readonly getSnapshot = (): RunVerdictContextValue => {
    const rows = this.source.getSnapshot().rows;
    if (this.value && rows === this.rows) {
      return this.value;
    }
    const previous = this.rows;
    this.rows = rows;
    // The log only appends: rows that add no verdict keep the value, so a long
    // thread's verdict consumers do not re-render per committed row (BST-2311).
    const appended =
      previous && previous.length <= rows.length && rows[previous.length - 1] === previous.at(-1)
        ? rows.slice(previous.length)
        : undefined;
    if (!(this.value && appended?.every((row) => row.event.type !== 'run.verdict'))) {
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
