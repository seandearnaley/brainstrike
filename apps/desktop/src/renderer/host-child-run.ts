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

  /**
   * Fold the rows past the last call; `rows` is the same log, grown. `error`
   * is the log subscription's failure: the run is then unavailable, never
   * "not started yet".
   */
  apply(rows: readonly HostLogRow[], error?: string): SubagentChildRun | undefined {
    if (rows.length < this.cursor) {
      throw new Error('A committed thread log never shrinks');
    }
    for (let index = this.cursor; index < rows.length; index += 1) {
      this.fold(rows[index]?.event);
    }
    this.cursor = rows.length;
    const next = this.read(error);
    if (
      next?.status !== this.value?.status ||
      next?.toolCalls !== this.value?.toolCalls ||
      (next?.status === 'unavailable' &&
        this.value?.status === 'unavailable' &&
        next.reason !== this.value.reason)
    ) {
      this.value = next;
    }
    return this.value;
  }

  private read(error: string | undefined): SubagentChildRun | undefined {
    if (error !== undefined) {
      return { reason: error, status: 'unavailable', toolCalls: this.toolCalls };
    }
    return this.latest === undefined
      ? undefined
      : { status: this.status(), toolCalls: this.toolCalls };
  }

  private fold(event: HostLogRow['event'] | undefined): void {
    switch (event?.type) {
      case 'run.started':
        this.first ??= event.runId;
        this.latest = event.runId;
        this.latestTurn = hostRootRunTurnId(event);
        this.outcome = undefined;
        this.answered = false;
        this.waiting.clear();
        return;
      case 'model.step':
      case 'model.messages':
        if (event.runId === this.latest) {
          this.answer(hostAnswerText(event.messages));
        }
        return;
      case 'stream.chunk':
        if (isHostToolCallChunk(event.chunk)) {
          this.toolCalls += 1;
        }
        return;
      case 'interaction.requested':
        if (event.runId === this.latest) {
          this.waiting.add(event.interactionId);
        }
        return;
      case 'interaction.responded':
        this.waiting.delete(event.interactionId);
        return;
      case 'run.finished':
        if (event.runId === this.latest) {
          this.outcome = event.outcome;
          this.waiting.clear();
        }
        return;
      default:
        return;
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
  private answer(text: string | undefined): void {
    if (text !== undefined) {
      this.answered = text !== '';
    }
  }

  private status(): Exclude<SubagentChildRun['status'], 'unavailable'> {
    if (this.outcome === 'completed' && !this.answered) {
      return 'no-answer';
    }
    if (this.outcome) {
      return this.outcome;
    }
    return this.waiting.size > 0 ? 'needs-input' : 'running';
  }
}

type UnavailableChildRun = Extract<SubagentChildRun, { status: 'unavailable' }>;

/**
 * The parents whose `thread/children` listing currently fails, each with its
 * reason. A child no listing has shown reads unavailable while any fails, so
 * its card never falls back to "working"; only that parent's own successful
 * listing clears its failure, never a descendant's.
 */
export class HostChildListingFailures {
  private readonly failures = new Map<string, UnavailableChildRun>();

  /** A parent's listing settled; whether the unlisted read changed. */
  record(parentThreadId: string, failure: string | undefined): boolean {
    const before = this.unlisted();
    if (failure === undefined) {
      this.failures.delete(parentThreadId);
    } else if (this.failures.get(parentThreadId)?.reason !== failure) {
      this.failures.set(parentThreadId, { reason: failure, status: 'unavailable', toolCalls: 0 });
    }
    return this.unlisted() !== before;
  }

  /** What a child no listing has shown reads; undefined while every listing succeeds. */
  unlisted(): UnavailableChildRun | undefined {
    return this.failures.values().next().value;
  }
}
