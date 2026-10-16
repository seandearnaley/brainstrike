import { hostAnswerText } from '@brainstrike/agent-host/child-answer';
import { hostRootRunTurnId } from '@brainstrike/agent-host/committed-identities';
import { isHostToolCallChunk } from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { SubagentChildRun } from '@brainstrike/assistant-ui';

/**
 * A host thread's run state, folded incrementally from its own committed log:
 * its latest run working, waiting on a person's answer, or how that run ended
 * (a completed run without an answer, by the host's child-result rule, reads
 * `no-answer`), and the tool calls its runs made, counted by the host ledger's
 * rule. Core starts one run at a time per thread, so the latest `run.started`
 * is the thread's current run. The value keeps its identity until one of those
 * facts changes; undefined before the thread's first run.
 */
export class HostChildRunFold {
  private cursor = 0;
  /** The child's first run: its delegated invocation, part of the parent's turn. */
  private first: string | undefined;
  private latest: string | undefined;
  /** The latest run's root turn, read as a root thread's run (`hostRootRunTurnId`). */
  private latestTurn: string | undefined;
  private outcome: Extract<HostLogRow['event'], { type: 'run.finished' }>['outcome'] | undefined;
  /** Whether the latest run's last assistant message so far has text. */
  private answered = false;
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
        this.latestTurn = hostRootRunTurnId(event);
        this.outcome = undefined;
        this.answered = false;
        this.waiting.clear();
        return true;
      case 'model.step':
      case 'model.messages':
        return event.runId === this.latest && this.answer(hostAnswerText(event.messages));
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

  /**
   * For a root thread: the turn its latest run belongs to, which that run's
   * Stop ends with the turn's background children. Undefined before its first run.
   */
  rootTurnId(): string | undefined {
    return this.latestTurn;
  }

  /** A step's messages replace the answer only when they hold an assistant message. */
  private answer(text: string | undefined): boolean {
    if (text === undefined || this.answered === (text !== '')) {
      return false;
    }
    this.answered = text !== '';
    return true;
  }

  private status(): SubagentChildRun['status'] {
    if (this.outcome === 'completed' && !this.answered) {
      return 'no-answer';
    }
    if (this.outcome) {
      return this.outcome;
    }
    return this.waiting.size > 0 ? 'needs-input' : 'running';
  }
}
