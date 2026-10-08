import type { HostEvent, HostLogRow } from './protocol.js';

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

/** Existing SQLite primary-key address, encoded for a library's string-ID port. */
export function committedRowAddress(row: Pick<HostLogRow, 'threadId' | 'seq'>): string {
  return JSON.stringify([row.threadId, row.seq]);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    !isObject(payload) ||
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

/** Canonical source rows, independent of a projection's timestamp requirement. */
export function committedRunSource(
  rows: readonly HostLogRow[],
  runId: string
): { readonly started: StartedRow; readonly accepted: AcceptedRow } {
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
      isObject(row.event.result) &&
      row.event.result['runId'] === runId
  );
  const acceptance = accepted[0];
  if (accepted.length !== 1 || !acceptance) {
    throw new Error('Run identity requires one committed start command');
  }
  if (!matchesAdmission(started, acceptance)) {
    throw new Error('Run start does not match its committed command');
  }
  return { accepted: acceptance, started };
}

/**
 * The run that committed user message `userMessageId` with its run/start
 * command. A regeneration answers it again but never creates it.
 */
function committedUserSource(
  rows: readonly HostLogRow[],
  threadId: string,
  userMessageId: string
): StartedRow {
  const accepted = rows.find(
    (row): row is AcceptedRow =>
      row.threadId === threadId &&
      row.event.type === 'command.accepted' &&
      row.event.method === 'run/start' &&
      row.event.commandId === userMessageId
  );
  const runId = isObject(accepted?.event.result) ? accepted.event.result['runId'] : undefined;
  if (typeof runId !== 'string') {
    throw new Error('Regenerated run references no committed user message');
  }
  return committedRunSource(rows, runId).started;
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
  const { started, accepted } = committedRunSource(rows, runId);
  if (started.ts === undefined) {
    throw new Error('Run identity requires its committed start and SQLite timestamp');
  }
  const reused = started.event.userMessageId;
  if (reused === undefined) {
    return {
      assistantMessageId: runId,
      createdAt: new Date(started.ts),
      parentMessageId: committedUserParent(rows, started),
      userMessageId: accepted.event.commandId,
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
