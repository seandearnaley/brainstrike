/**
 * ADR-0028 step 3b: what a thread is told while it works or waits. A notice is
 * posted once on that thread's log, by the commit that settles it (a child
 * run's end, a command session's exit, a person's run/input), and is taken by
 * the run whose `delivery` names it. Whether a run has taken a notice is read along its own
 * branch, so an edit, a regenerate or a rewind that leaves the run that took
 * one finds it due again (while the branch still holds the run that dispatched
 * a child's work), and a notice outlives the child thread it reports.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { UserModelMessage } from 'ai';
import { Schema } from 'effect';
import { describeHostDelivery } from './child-delivery.ts';
import { hostChildResult } from './child-runs.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import { describeHostCommandSessionExits } from './core-command-exits.ts';
import type { HostRunState } from './core-state.ts';
import type { HostCommandSessionExit } from './ports.ts';
import {
  HOST_METHOD_SCHEMAS,
  type HostChildDelivery,
  type HostChildDeliveryEntry,
  type HostEvent,
  type HostLogRow,
  type HostNotice,
  type HostParams,
  type HostStepDelivery,
} from './protocol.ts';
import { type HostRunPosition, hostRunAncestors } from './run-branch.ts';
import { hostIntakeMessage, hostPersonInputMessage } from './turn-input.ts';

export type HostChildNotice = Extract<HostNotice, { kind: 'child' }>;
export type HostSessionNotice = Extract<HostNotice, { kind: 'command-session' }>;
/** A person's message to a thread, its committed run/input: the command is the notice's one record. */
export interface HostInputNotice {
  readonly kind: 'input';
  readonly params: HostParams<'run/input'>;
}
export type HostThreadNotice = HostNotice | HostInputNotice;

/** The identity a delivery names a notice by: the child run, the command session, or the input's command. */
export function hostNoticeId(notice: HostThreadNotice): string {
  if (notice.kind === 'input') {
    return notice.params.commandId;
  }
  return notice.kind === 'child' ? notice.entry.childRunId : notice.session.sessionId;
}

/** The run/start command ID of the run a person's input starts on an idle thread. */
export function hostInputRunCommandId(input: HostInputNotice): string {
  return `${input.params.commandId}-input`;
}

/** A refused input run's start and end, its run.started naming the input it took. */
export function hostInputTakenBy(
  input: HostInputNotice,
  events: readonly HostEvent[]
): HostEvent[] {
  const inputs = [input.params.commandId];
  return events.map((event) =>
    event.type === 'run.started'
      ? { ...event, delivery: { entries: [], inputs, messageId: randomUUID(), via: 'next-turn' } }
      : event
  );
}

function deliveredIds(delivery: HostChildDelivery | HostStepDelivery | undefined): string[] {
  return [
    ...(delivery?.entries ?? []).map((entry) => entry.childRunId),
    ...(delivery?.commandSessions ?? []).map((session) => session.sessionId),
    ...(hostDeliveredInputs(delivery) ?? []),
  ];
}

/** The person's inputs a run took, at its start or a step: a wake takes none. */
export function hostDeliveredInputs(
  delivery: HostChildDelivery | HostStepDelivery | undefined
): string[] | undefined {
  return delivery && 'inputs' in delivery ? delivery.inputs : undefined;
}

/** The branch through `run` (`run` and its ancestors), and the notices its runs took, at their start or a step. */
export interface HostNoticeBranch {
  readonly runs: ReadonlySet<string>;
  readonly taken: ReadonlySet<string>;
}

export function hostNoticeBranch(
  runs: ReadonlyMap<string, HostRunState>,
  run: HostRunState | undefined
): HostNoticeBranch {
  const path = run ? [...hostRunAncestors(runs, run), run] : [];
  return {
    runs: new Set(path.map((turn) => turn.id)),
    taken: new Set(
      path.flatMap((turn) => [turn.branch.delivery, ...turn.intake].flatMap(deliveredIds))
    ),
  };
}

/** Every thread's posted notices, folded from the committed log in commit order. */
export class HostNotices {
  private readonly posted = new Map<string, HostThreadNotice[]>();
  /** Command sessions an idle child handed on to the thread that hears them now. */
  private readonly handedOn = new Map<string, Set<string>>();

  fold(row: HostLogRow): void {
    const { event } = row;
    if (event.type === 'command.accepted' && event.method === 'run/input') {
      const params = Schema.decodeUnknownSync(HOST_METHOD_SCHEMAS['run/input'])(event.payload);
      this.post(row.threadId, { kind: 'input', params });
    } else if (event.type === 'notice.posted') {
      this.post(row.threadId, event.notice);
    }
  }

  private post(threadId: string, notice: HostThreadNotice): void {
    const posted = this.posted.get(threadId) ?? [];
    posted.push(notice);
    this.posted.set(threadId, posted);
    if (notice.kind === 'command-session' && notice.handedOnFrom !== undefined) {
      const from = this.handedOn.get(notice.handedOnFrom) ?? new Set<string>();
      from.add(notice.session.sessionId);
      this.handedOn.set(notice.handedOnFrom, from);
    }
  }

  forget(threadId: string): void {
    this.posted.delete(threadId);
    this.handedOn.delete(threadId);
  }

  /** Whether `threadId` was ever told this notice. */
  has(threadId: string, id: string): boolean {
    return (this.posted.get(threadId) ?? []).some((notice) => hostNoticeId(notice) === id);
  }

  /** `threadId`'s notices in post order, except those it handed on. */
  of(threadId: string): readonly HostThreadNotice[] {
    const away = this.handedOn.get(threadId);
    return (this.posted.get(threadId) ?? []).filter(
      (notice) => !(notice.kind === 'command-session' && away?.has(notice.session.sessionId))
    );
  }

  /**
   * `threadId`'s notices due on `branch`: not yet taken there, and, for a
   * child's report, dispatched there; for an input, sent to a run there. A
   * branch that left that run never asked for that work or heard that message.
   */
  due(threadId: string, branch: HostNoticeBranch): HostThreadNotice[] {
    return this.of(threadId).filter(
      (notice) => !branch.taken.has(hostNoticeId(notice)) && onBranch(notice, branch)
    );
  }
}

/** A report is due where its work was dispatched, an input where it was sent; an exit anywhere. */
function onBranch(notice: HostThreadNotice, branch: HostNoticeBranch): boolean {
  if (notice.kind === 'command-session') {
    return true;
  }
  return branch.runs.has(notice.kind === 'child' ? notice.entry.parentRunId : notice.params.runId);
}

type Outcome = NonNullable<HostRunState['outcome']>;
function settledState(outcome: Outcome): HostChildDeliveryEntry['state'] {
  if (outcome === 'completed') {
    return 'returned';
  }
  return outcome === 'stopped' ? 'cancelled' : 'failed';
}
/** A settled child run's report, in the words its parent's model reads. */
export function hostChildNotice(
  run: HostRunState,
  invocation: boolean,
  ended: { readonly detail?: string | undefined; readonly outcome: Outcome | undefined }
): HostChildNotice {
  const origin = run.origin;
  if (!(origin && ended.outcome)) {
    throw new Error('Only a settled child run reports');
  }
  const label = origin.profile?.label ?? origin.persona;
  const persona: AssistantPersonaDefinition = {
    allowedToolIds: [],
    description: origin.persona,
    id: origin.persona,
    instructions: '',
    label,
    maxSteps: run.snapshot?.maxSteps ?? 0,
  };
  return {
    entry: {
      childRunId: run.id,
      childThreadId: run.threadId,
      ...(invocation ? {} : { followUp: true as const }),
      outcome: hostChildResult(run.threadId, persona, ended.outcome, run.messages).text,
      parentRunId: origin.parentRunId,
      state: settledState(ended.outcome),
      toolCallId: origin.toolCallId,
    },
    kind: 'child',
    persona: label,
    prompt: run.branch.prompt,
    ...(ended.detail === undefined ? {} : { reason: ended.detail }),
    toolName: `agent-${origin.persona}`,
    ...(invocation ? { turnId: origin.turnId } : {}),
  };
}
type HostPendingNotices = ReturnType<HostChildRuns['pending']>;

/** The pending notices as the model reads them, and the delivery that names them. */
function hostNoticeReport(pending: HostPendingNotices, threadId: string) {
  const sessions = pending?.sessions ?? [];
  const exits = sessions.map(
    ({ createdAt, exitedAt, outputCursor, session }): HostCommandSessionExit => ({
      ...session,
      createdAt,
      exitedAt,
      outputCursor,
    })
  );
  const parts = [
    pending?.ledger,
    exits.length > 0 ? describeHostCommandSessionExits(threadId, exits) : undefined,
  ];
  return {
    delivery: {
      ...(sessions.length > 0 ? { commandSessions: sessions.map(({ session }) => session) } : {}),
      entries: pending?.entries ?? [],
    },
    report: parts.some(Boolean) ? describeHostDelivery(parts) : '',
  };
}

/**
 * A new run's position with the notices it takes (BST-1932, ADR-0028 step
 * 3b): a wake's prompt is that delivery; any other run carries it ahead of the
 * person's own message. `inputs`: the person's inputs whose words are this
 * run's own prompt. `turnId`: the turn a wake continues when it takes no
 * invocation's result.
 */
export function hostDeliveryPosition(
  method: string,
  messageId: string,
  position: HostRunPosition,
  pending: HostPendingNotices,
  ended: { readonly inputs?: string[]; readonly threadId: string; readonly turnId: string }
): HostRunPosition {
  const { delivery, report } = hostNoticeReport(pending, ended.threadId);
  if (method === 'wake') {
    if (report === '') {
      throw new Error('A wake has nothing undelivered');
    }
    const turnId = pending?.turnId ?? ended.turnId;
    return {
      ...position,
      delivery: { ...delivery, messageId, turnId, via: 'wake' },
      prompt: report,
    };
  }
  const inputs = ended.inputs?.length ? { inputs: ended.inputs } : {};
  if (report === '' && !inputs.inputs) {
    return position;
  }
  return {
    ...position,
    delivery: {
      ...delivery,
      ...inputs,
      ...(report === '' ? {} : { ledger: report }),
      messageId: randomUUID(),
      via: 'next-turn',
    },
  };
}

/**
 * ADR-0028 step 3b: the notices a running run takes at its next step, each a
 * user message to its model with the delivery its `model.messages` commits it
 * with: the reports in one, then each person's input in its own, in post order.
 */
export function hostNoticeIntake(
  pending: HostPendingNotices,
  threadId: string
): { readonly delivery: HostStepDelivery; readonly message: UserModelMessage }[] {
  const { delivery, report } = hostNoticeReport(pending, threadId);
  return [
    ...(report === '' ? [] : [{ delivery, message: hostIntakeMessage(report) }]),
    ...(pending?.inputs ?? []).map(({ params }) => ({
      delivery: { entries: [], inputs: [params.commandId] },
      message: hostPersonInputMessage(params),
    })),
  ];
}
