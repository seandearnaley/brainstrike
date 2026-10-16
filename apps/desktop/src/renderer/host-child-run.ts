import { isHostToolCallChunk } from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { SubagentChildRun } from '@brainstrike/assistant-ui';

/**
 * A host thread's run state, folded incrementally from its own committed log:
 * its latest run working, waiting on a person's answer, or how that run ended,
 * and the tool calls its runs made, counted by the host ledger's rule. Core
 * starts one run at a time per thread, so the latest `run.started` is the
 * thread's current run. The value keeps its identity until one of those facts
 * changes; undefined before the thread's first run.
 */
export class HostChildRunFold {
  private cursor = 0;
  /** The child's first run: its delegated invocation, part of the parent's turn. */
  private first: string | undefined;
  private latest: string | undefined;
  private outcome: Extract<HostLogRow['event'], { type: 'run.finished' }>['outcome'] | undefined;
  /** Interactions the latest run asked and nobody has answered yet. */
  private readonly waiting = new Set<string>();
  private toolCalls = 0;
  private value: SubagentChildRun | undefined;

  /** Fold the rows past the last call; `rows` is the same log, grown. */
  apply(rows: readonly HostLogRow[]): SubagentChildRun | undefined {
    if (rows.length < this.cursor) {
      throw new Error('A committed thread log never shrinks');
    }
    let changed = false;
    for (let index = this.cursor; index < rows.length; index += 1) {
      changed = this.fold(rows[index]?.event) || changed;
    }
    this.cursor = rows.length;
    if (!changed || this.latest === undefined) {
      return this.value;
    }
    const status = this.status();
    if (this.value?.status !== status || this.value.toolCalls !== this.toolCalls) {
      this.value = { status, toolCalls: this.toolCalls };
    }
    return this.value;
  }

  private fold(event: HostLogRow['event'] | undefined): boolean {
    switch (event?.type) {
      case 'run.started':
        this.first ??= event.runId;
        this.latest = event.runId;
        this.outcome = undefined;
        this.waiting.clear();
        return true;
      case 'stream.chunk':
        if (!isHostToolCallChunk(event.chunk)) {
          return false;
        }
        this.toolCalls += 1;
        return true;
      case 'interaction.requested':
        if (event.runId !== this.latest) {
          return false;
        }
        this.waiting.add(event.interactionId);
        return true;
      case 'interaction.responded':
        return this.waiting.delete(event.interactionId);
      case 'run.finished':
        if (event.runId !== this.latest) {
          return false;
        }
        this.outcome = event.outcome;
        this.waiting.clear();
        return true;
      default:
        return false;
    }
  }

  /**
   * Whether the child's current run is its delegated invocation. Core starts
   * any later run (input, Retry, Edit) as a follow-up with a turn of its own
   * (`adopt` in core-child-runs), which the parent's turn Stop does not end.
   */
  runsDelegatedInvocation(): boolean {
    return this.latest !== undefined && this.latest === this.first;
  }

  private status(): SubagentChildRun['status'] {
    if (this.outcome) {
      return this.outcome;
    }
    return this.waiting.size > 0 ? 'needs-input' : 'running';
  }
}
