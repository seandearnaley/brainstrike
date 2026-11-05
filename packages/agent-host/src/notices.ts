/**
 * ADR-0028 step 3b: what a thread is told that no person typed. A notice is
 * posted once on that thread's log, by the commit that settles it (a child
 * run's end, a command session's exit), and is taken by the run whose
 * `delivery` names it. Whether a run has taken a notice is read along its own
 * branch, so an edit, a regenerate or a rewind that leaves the run that took
 * one finds it due again (while the branch still holds the run that dispatched
 * a child's work), and a notice outlives the child thread it reports.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { UserModelMessage } from 'ai';
import { describeHostDelivery } from './child-delivery.ts';
import { hostChildResult } from './child-runs.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import { describeHostCommandSessionExits } from './core-command-exits.ts';
import type { HostRunState } from './core-state.ts';
import type { HostCommandSessionExit } from './ports.ts';
import type {
  HostChildDelivery,
  HostChildDeliveryEntry,
  HostLogRow,
  HostNotice,
  HostStepDelivery,
} from './protocol.ts';
import { type HostRunPosition, hostRunAncestors } from './run-branch.ts';
import { hostIntakeMessage } from './turn-input.ts';

export type HostChildNotice = Extract<HostNotice, { kind: 'child' }>;
export type HostSessionNotice = Extract<HostNotice, { kind: 'command-session' }>;

/** The identity a delivery names a notice by: the child run, or the command session. */
export function hostNoticeId(notice: HostNotice): string {
  return notice.kind === 'child' ? notice.entry.childRunId : notice.session.sessionId;
}

function deliveredIds(delivery: HostChildDelivery | HostStepDelivery | undefined): string[] {
  return [
    ...(delivery?.entries ?? []).map((entry) => entry.childRunId),
    ...(delivery?.commandSessions ?? []).map((session) => session.sessionId),
  ];
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
  private readonly posted = new Map<string, HostNotice[]>();
  /** Command sessions an idle child handed on to the thread that hears them now. */
  private readonly handedOn = new Map<string, Set<string>>();

  fold(row: HostLogRow): void {
    if (row.event.type !== 'notice.posted') {
      return;
    }
    const { notice } = row.event;
    const posted = this.posted.get(row.threadId) ?? [];
    posted.push(notice);
    this.posted.set(row.threadId, posted);
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
  of(threadId: string): readonly HostNotice[] {
    const away = this.handedOn.get(threadId);
    return (this.posted.get(threadId) ?? []).filter(
      (notice) => !(notice.kind === 'command-session' && away?.has(notice.session.sessionId))
    );
  }

  /**
   * `threadId`'s notices due on `branch`: not yet taken there, and, for a
   * child's report, dispatched there. A branch that left the dispatching run
   * never asked for that work.
   */
  due(threadId: string, branch: HostNoticeBranch): HostNotice[] {
    return this.of(threadId).filter(
      (notice) =>
        !branch.taken.has(hostNoticeId(notice)) &&
        (notice.kind !== 'child' || branch.runs.has(notice.entry.parentRunId))
    );
  }
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
 * person's own message. `turnId`: the turn a wake continues when it takes no
 * invocation's result.
 */
export function hostDeliveryPosition(
  method: string,
  messageId: string,
  position: HostRunPosition,
  pending: HostPendingNotices,
  ended: { readonly threadId: string; readonly turnId: string }
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
  if (report === '') {
    return position;
  }
  return {
    ...position,
    delivery: { ...delivery, ledger: report, messageId: randomUUID(), via: 'next-turn' },
  };
}

/**
 * ADR-0028 step 3b: the notices a running run takes at its next step, as the
 * user message that carries them to its model and the delivery its
 * `model.messages` commits with them. None when nothing is due.
 */
export function hostNoticeIntake(
  pending: HostPendingNotices,
  threadId: string
): { readonly delivery: HostStepDelivery; readonly message: UserModelMessage } | undefined {
  const { delivery, report } = hostNoticeReport(pending, threadId);
  return report === '' ? undefined : { delivery, message: hostIntakeMessage(report) };
}
