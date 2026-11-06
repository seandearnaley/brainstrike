import { Predicate } from 'effect';
import type { HostRunState } from './core-state.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';

export interface CommittedRunIdentity {
  readonly assistantMessageId: string;
  readonly createdAt: Date;
  readonly parentMessageId: string | null;
  readonly userMessageId: string;
}

type StartedRow = HostLogRow & { readonly event: Extract<HostEvent, { type: 'run.started' }> };
type AcceptedRow = HostLogRow & {
  readonly event: Extract<HostEvent, { type: 'command.accepted' }>;
};

/** The commands whose acceptance admits a run. */
const RUN_ADMISSIONS: ReadonlySet<string> = new Set(['run/regenerate', 'run/start']);

/**
 * The root turn a root thread's run belongs to, from its `run.started`: a wake
 * continues the turn whose children it delivers, and a run the host started to
 * carry a run's task on (ADR-0028 step 3) the turn it names; any other run
 * starts its own. A run/stop of that turn's ID ends its background children
 * (`hostRunTurnId`).
 */
export function hostRootRunTurnId(started: {
  readonly delivery?: Extract<HostEvent, { type: 'run.started' }>['delivery'] | undefined;
  readonly runId: string;
  readonly turnId?: string | undefined;
}): string {
  if (started.delivery?.via === 'wake') {
    return started.delivery.turnId;
  }
  return started.turnId ?? started.runId;
}

/**
 * The root turn a run belongs to, as its `run.started` committed it
 * (`startedHostRun`): a wake or a carried-on run keeps its turn's ID, a worker
 * its invocation's, and any other run starts its own.
 */
export function hostRunTurnId(run: HostRunState): string {
  return run.turnId ?? run.origin?.turnId ?? run.id;
}
/**
 * The one "turn stopped" fact (audit SC-5): a Stop of a run that carries the
 * turn itself, on any thread: its first run, a wake or a continuation. A Stop
 * of one of the turn's workers ends that worker, not the turn.
 */
export function hostTurnStopped(runs: ReadonlyMap<string, HostRunState>, turnId: string): boolean {
  for (const run of runs.values()) {
    if (run.stopped && hostRunTurnId(run) === turnId && run.origin?.turnId !== turnId) {
      return true;
    }
  }
  return false;
}

/** Existing SQLite primary-key address, encoded for a library's string-ID port. */
export function committedRowAddress(row: Pick<HostLogRow, 'threadId' | 'seq'>): string {
  return JSON.stringify([row.threadId, row.seq]);
}

function startedRow(rows: readonly HostLogRow[], runId: string): StartedRow | undefined {
  return rows.find(
    (row): row is StartedRow => row.event.type === 'run.started' && row.event.runId === runId
  );
}

/** The command's committed input names exactly the branch position its run.started records. */
function matchesAdmission(started: StartedRow, accepted: AcceptedRow): boolean {
  const payload = accepted.event.payload;
  const event = started.event;
  if (
    !Predicate.isObject(payload) ||
    payload['threadId'] !== started.threadId ||
    payload['modelId'] !== event.modelId
  ) {
    return false;
  }
  if (accepted.event.method === 'run/regenerate') {
    return payload['userMessageId'] === event.userMessageId && !('parentMessageId' in event);
  }
  return (
    payload['prompt'] === event.prompt &&
    event.userMessageId === undefined &&
    (!('parentMessageId' in payload) || payload['parentMessageId'] === event.parentMessageId)
  );
}

interface RunAdmission {
  readonly admissionId: string;
  /** The other committed rows the admission is read from (`committedRunSource`). */
  readonly sources: readonly number[];
}

/**
 * BST-1932: the user message a host-admitted run answers without a client
 * command, as `foldHostRunBranch` admits it. A child thread's first run
 * answers its delegation task, keyed by the child thread; a wake answers its
 * delivery after the run it was admitted behind, keyed by the delivery.
 */
function hostAdmission(rows: readonly HostLogRow[], started: StartedRow): RunAdmission | undefined {
  const event = started.event;
  if (event.delivery?.via === 'wake') {
    return typeof event.parentMessageId === 'string'
      ? { admissionId: event.delivery.messageId, sources: [] }
      : undefined;
  }
  const thread = rows.filter((row) => row.threadId === started.threadId);
  const delegation = thread.find(
    ({ event: candidate }) => candidate.type === 'thread.started' && 'origin' in candidate
  );
  const first = thread.find((row) => row.event.type === 'run.started');
  return delegation && first?.seq === started.seq && event.parentMessageId === null
    ? { admissionId: started.threadId, sources: [delegation.seq] }
    : undefined;
}

/**
 * Canonical source rows, independent of a projection's timestamp requirement.
 * `admissionId` names the user message the run's admission committed: its
 * client command, or a host-admitted delegation or wake. `sources` are the
 * other rows it is read from: the accepted command, or the delegation's
 * `thread.started`. Every other condition is that no earlier row matches,
 * which an append cannot change.
 */
export function committedRunSource(
  rows: readonly HostLogRow[],
  runId: string
): RunAdmission & { readonly started: StartedRow } {
  const started = startedRow(rows, runId);
  if (!started) {
    throw new Error('Run identity requires its committed start');
  }
  const accepted = rows.filter(
    (row): row is AcceptedRow =>
      row.threadId === started.threadId &&
      row.seq < started.seq &&
      row.event.type === 'command.accepted' &&
      RUN_ADMISSIONS.has(row.event.method) &&
      Predicate.isObject(row.event.result) &&
      row.event.result['runId'] === runId
  );
  const acceptance = accepted[0];
  if (accepted.length > 1) {
    throw new Error('Run identity requires one committed start command');
  }
  if (acceptance) {
    if (!matchesAdmission(started, acceptance)) {
      throw new Error('Run start does not match its committed command');
    }
    return { admissionId: acceptance.event.commandId, sources: [acceptance.seq], started };
  }
  const admission = hostAdmission(rows, started);
  if (admission === undefined) {
    throw new Error('Run identity requires one committed start command');
  }
  return { ...admission, started };
}

/**
 * The run whose admission committed user message `userMessageId`. A
 * regeneration answers it again but never creates it.
 */
function committedUserSource(
  rows: readonly HostLogRow[],
  threadId: string,
  userMessageId: string
): StartedRow {
  for (const row of rows) {
    if (
      row.threadId === threadId &&
      row.event.type === 'run.started' &&
      row.event.userMessageId === undefined
    ) {
      const source = committedRunSource(rows, row.event.runId);
      if (source.admissionId === userMessageId) {
        return source.started;
      }
    }
  }
  throw new Error('Regenerated run references no committed user message');
}

/**
 * The parent of the user message that `started` committed. Branch history
 * records it on run.started; a row committed before branch history follows
 * the previous run, which was the only history then.
 */
function committedUserParent(rows: readonly HostLogRow[], started: StartedRow): string | null {
  const parent = started.event.parentMessageId;
  return parent === undefined ? previousCommittedMessage(rows, started) : parent;
}

/** Projections reuse the accepted input command and root run; no message ID writer. */
export function committedRunIdentity(
  rows: readonly HostLogRow[],
  runId: string
): CommittedRunIdentity {
  const { admissionId, started } = committedRunSource(rows, runId);
  if (started.ts === undefined) {
    throw new Error('Run identity requires its committed start and SQLite timestamp');
  }
  const reused = started.event.userMessageId;
  if (reused === undefined) {
    return {
      assistantMessageId: runId,
      createdAt: new Date(started.ts),
      parentMessageId: committedUserParent(rows, started),
      userMessageId: admissionId,
    };
  }
  const original = committedUserSource(rows, started.threadId, reused);
  if (original.event.prompt !== started.event.prompt) {
    throw new Error('Regenerated run does not repeat its committed user message');
  }
  return {
    assistantMessageId: runId,
    createdAt: new Date(started.ts),
    parentMessageId: committedUserParent(rows, original),
    userMessageId: reused,
  };
}

/**
 * The runs (assistant messages) on `runId`'s committed branch, root first,
 * excluding the run itself. A sibling branch is never on it.
 */
export function committedRunAncestors(rows: readonly HostLogRow[], runId: string): string[] {
  const { threadId } = committedRunSource(rows, runId).started;
  const chain: string[] = [];
  const seen = new Set([runId]);
  for (
    let parent = committedRunIdentity(rows, runId).parentMessageId;
    parent !== null;
    parent = committedRunIdentity(rows, parent).parentMessageId
  ) {
    if (seen.has(parent)) {
      throw new Error('Committed branch links form a cycle');
    }
    if (committedRunSource(rows, parent).started.threadId !== threadId) {
      throw new Error('Committed branch parent belongs to another thread');
    }
    seen.add(parent);
    chain.push(parent);
  }
  return chain.reverse();
}

/** True when the thread holds a committed run off this run's path (a sibling branch). */
export function committedThreadBranches(rows: readonly HostLogRow[], runId: string): boolean {
  const { threadId } = committedRunSource(rows, runId).started;
  const path = new Set([...committedRunAncestors(rows, runId), runId]);
  return rows.some(
    ({ event, threadId: rowThread }) =>
      rowThread === threadId && event.type === 'run.started' && !path.has(event.runId)
  );
}

function previousCommittedMessage(rows: readonly HostLogRow[], started: HostLogRow): string | null {
  const identities = new Set<string>();
  let parentMessageId: string | null = null;
  for (const row of rows) {
    if (row.threadId !== started.threadId || row.seq > started.seq) {
      continue;
    }
    const event = row.event;
    const id =
      event.type === 'run.started'
        ? event.runId
        : event.type === 'command.accepted' && event.method === 'run/start'
          ? event.commandId
          : undefined;
    if (id === undefined) {
      continue;
    }
    if (identities.has(id)) {
      throw new Error('Committed conversation identities collide');
    }
    identities.add(id);
    if (event.type === 'run.started' && row.seq < started.seq) {
      parentMessageId = event.runId;
    }
  }
  return parentMessageId;
}
