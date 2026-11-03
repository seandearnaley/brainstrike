import { refusalError } from '@brainstrike/assistant-contract';
import { hostAnswerText } from './child-answer.ts';
import { hostRootRunTurnId } from './committed-identities.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import { HostToolCallCount } from './ledger-projection.ts';
import type {
  HostAnsweredApproval,
  HostEvent,
  HostInteractionRequested,
  HostLogRow,
  HostResults,
  HostSummaryRun,
} from './protocol.ts';
import type { HostThreadCatalog } from './thread-catalog.ts';

type Outcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/** A thread's summary as Core folds it from its committed log. */
export interface HostThreadSummary {
  readonly answered: readonly HostAnsweredApproval[];
  readonly pending: readonly HostInteractionRequested[];
  readonly run: HostSummaryRun | null;
}

const NONE: readonly never[] = [];

/**
 * One thread's summary, folded incrementally from its committed log at O(1) per
 * row. A thread delegated beneath an open conversation shows its card,
 * approvals and questions from this, never from its whole log (BST-1932).
 *
 * Its latest run is working, waiting on a person's answer, or ended. A completed
 * run without an answer reads `no-answer`, by the host's child-result rule. The
 * tool calls its runs made are counted by the ledger's rule. Core starts one
 * run at a time per thread, so the latest `run.started` is the current run.
 */
class ThreadSummaryFold {
  /** The thread's first run: a child's delegated invocation, part of its parent's turn. */
  private first: string | undefined;
  private latest: string | undefined;
  /** The latest run's root turn, read as a root thread's run (`hostRootRunTurnId`). */
  private latestTurn = '';
  private outcome: Outcome | undefined;
  /** The latest run's model messages, step by step, read for its answer once it completes. */
  private steps: (readonly unknown[])[] = [];
  /** Whether the latest run completed with an answer. */
  private answeredText = false;
  /** Interactions the latest run asked and nobody has answered yet. */
  private readonly waiting = new Set<string>();
  private readonly toolCalls = new HostToolCallCount();
  /** Each run's unanswered interactions, until that run ends. */
  private readonly pending = new Map<string, HostInteractionRequested>();
  /** Approvals asked and not yet answered, kept to pair with their answers. */
  private readonly asked = new Map<string, HostInteractionRequested>();
  private answered: readonly HostAnsweredApproval[] = NONE;
  private value: HostThreadSummary = { answered: NONE, pending: NONE, run: null };

  read(): HostThreadSummary {
    return this.value;
  }

  /** Fold one row; true when the summary changed. */
  apply(event: HostEvent): boolean {
    const before = this.value;
    const pendingChanged = this.fold(event);
    const run = this.run();
    const same =
      !pendingChanged &&
      this.answered === before.answered &&
      (run === before.run ||
        (run !== null &&
          before.run !== null &&
          run.status === before.run.status &&
          run.toolCalls === before.run.toolCalls &&
          run.delegatedInvocation === before.run.delegatedInvocation &&
          run.turnId === before.run.turnId));
    if (same) {
      return false;
    }
    this.value = {
      answered: this.answered,
      pending: pendingChanged ? [...this.pending.values()] : before.pending,
      run,
    };
    return true;
  }

  /** Whether the pending interactions changed. */
  private fold(event: HostEvent): boolean {
    this.toolCalls.apply(event);
    switch (event.type) {
      case 'run.started':
        this.first ??= event.runId;
        this.latest = event.runId;
        this.latestTurn = hostRootRunTurnId(event);
        this.outcome = undefined;
        this.answeredText = false;
        this.steps = [];
        this.waiting.clear();
        return false;
      case 'model.step':
      case 'model.messages':
        if (event.runId === this.latest) {
          this.steps.push(event.messages);
        }
        return false;
      case 'interaction.requested':
        if (event.runId === this.latest) {
          this.waiting.add(event.interactionId);
        }
        if (event.kind === 'approval') {
          this.asked.set(event.interactionId, event);
        }
        this.pending.set(event.interactionId, event);
        return true;
      case 'interaction.responded':
        return this.responded(event);
      case 'run.finished':
        return this.finished(event.runId, event.outcome);
      default:
        return false;
    }
  }

  private responded(event: Extract<HostEvent, { type: 'interaction.responded' }>): boolean {
    this.waiting.delete(event.interactionId);
    const approval = this.asked.get(event.interactionId);
    if (approval && 'decision' in event) {
      this.asked.delete(event.interactionId);
      this.answered = [
        ...this.answered,
        { approval, byPolicy: event.by === 'policy', decision: event.decision },
      ];
    }
    return this.pending.delete(event.interactionId);
  }

  private finished(runId: string, outcome: Outcome): boolean {
    if (runId === this.latest) {
      this.outcome = outcome;
      this.answeredText = outcome === 'completed' && this.answeredInLatestRun();
      this.steps = [];
      this.waiting.clear();
    }
    let changed = false;
    for (const [interactionId, interaction] of this.pending) {
      if (interaction.runId === runId) {
        this.pending.delete(interactionId);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Whether the latest run's last assistant message has text. Read once, when
   * the run completes, never at every step: a host opening thousands of
   * threads decodes each run's answer once.
   */
  private answeredInLatestRun(): boolean {
    for (let step = this.steps.length - 1; step >= 0; step -= 1) {
      const text = hostAnswerText(this.steps[step] ?? []);
      if (text !== undefined) {
        return text !== '';
      }
    }
    return false;
  }

  private run(): HostSummaryRun | null {
    if (this.latest === undefined) {
      return null;
    }
    return {
      delegatedInvocation: this.latest === this.first,
      status: this.status(),
      toolCalls: this.toolCalls.size,
      turnId: this.latestTurn,
    };
  }

  private status(): HostSummaryRun['status'] {
    if (this.outcome === 'completed' && !this.answeredText) {
      return 'no-answer';
    }
    if (this.outcome) {
      return this.outcome;
    }
    return this.waiting.size > 0 ? 'needs-input' : 'running';
  }
}

const EMPTY: HostThreadSummary = { answered: NONE, pending: NONE, run: null };

/** Core's per-thread summaries, fed each committed row once, as it commits or as Core hydrates it. */
export class HostThreadSummaries {
  private readonly threads = new Map<string, ThreadSummaryFold>();
  /** Each thread's last row that changed its summary. */
  private readonly revisions = new Map<string, number>();

  apply(row: HostLogRow): void {
    let fold = this.threads.get(row.threadId);
    if (!fold) {
      fold = new ThreadSummaryFold();
      this.threads.set(row.threadId, fold);
    }
    if (fold.apply(row.event)) {
      this.revisions.set(row.threadId, row.seq);
    }
  }

  /** Whether `row` changed its thread's summary. */
  changedBy(row: Pick<HostLogRow, 'seq' | 'threadId'>): boolean {
    return this.revisions.get(row.threadId) === row.seq;
  }

  read(threadId: string): HostThreadSummary {
    return this.threads.get(threadId)?.read() ?? EMPTY;
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
    this.revisions.delete(threadId);
  }
}

type HostTree = HostResults['thread/tree'];

type Children = HostResults['thread/children']['children'];

/** BST-1932: `thread/tree`, and which committed rows change a tree. */
export class HostThreadTrees {
  private readonly summaries: HostThreadSummaries;
  /** Why a thread's history cannot be read, when it cannot. */
  private readonly catalog: Pick<HostThreadCatalog, 'entry'>;
  private readonly registry: Pick<HostChildRuns, 'descendants' | 'parentOf'>;
  /** Every committed thread: a delegation reserves its origin before its thread commits. */
  private readonly threads: ReadonlySet<string>;
  private readonly listed: (threadId: string) => Children;

  constructor(
    projections: { readonly summaries: HostThreadSummaries },
    catalog: Pick<HostThreadCatalog, 'entry'>,
    registry: Pick<HostChildRuns, 'descendants' | 'parentOf'>,
    sources: {
      readonly listed: (threadId: string) => Children;
      readonly threads: ReadonlySet<string>;
    }
  ) {
    this.summaries = projections.summaries;
    this.catalog = catalog;
    this.registry = registry;
    this.threads = sources.threads;
    this.listed = sources.listed;
  }

  /** A thread's direct child threads, in delegation order, with their origins. */
  children(threadId: string): Children {
    return this.listed(threadId);
  }

  /** A thread's summary and each thread delegated beneath it, parents before their children. */
  read(threadId: string): HostTree {
    if (!this.threads.has(threadId)) {
      throw refusalError('input', 'thread.unknown', 'Unknown thread');
    }
    const delegated = this.registry.descendants(threadId, this.threads);
    // Each family colour as its parent's listing allocates it.
    const colors = new Map(
      [...new Set(delegated.map(({ origin }) => origin.parentThreadId))].flatMap((parent) =>
        this.listed(parent).map(({ color, threadId: child }) => [child, color] as const)
      )
    );
    const descendants = delegated.map(({ callSign, origin, threadId: child }) => {
      const color = colors.get(child);
      if (color === undefined) {
        throw new Error('A child conversation has no family colour.');
      }
      return { ...this.summary(child), callSign, color, origin };
    });
    return { descendants, thread: this.summary(threadId) };
  }

  /**
   * The threads whose trees a committed row changed: its thread and each thread
   * above it, nearest first; undefined when the row changed no summary.
   */
  changedBy(row: Pick<HostLogRow, 'seq' | 'threadId'>): string[] | undefined {
    if (!this.summaries.changedBy(row)) {
      return;
    }
    const lineage = [row.threadId];
    let parent = this.registry.parentOf(row.threadId);
    while (parent !== undefined) {
      lineage.push(parent);
      parent = this.registry.parentOf(parent);
    }
    return lineage;
  }

  private summary(threadId: string): HostTree['thread'] {
    const { damage } = this.catalog.entry(threadId);
    const { answered, pending, run } = this.summaries.read(threadId);
    return {
      answered: [...answered],
      ...(damage === undefined ? {} : { damage }),
      pending: [...pending],
      run,
      threadId,
    };
  }
}
