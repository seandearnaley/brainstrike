import type { HostLogRow } from './protocol.js';

export interface CommittedRunIdentity {
  readonly assistantMessageId: string;
  readonly createdAt: Date;
  readonly parentMessageId: string | null;
  readonly userMessageId: string;
}

/** Existing SQLite primary-key address, encoded for a library's string-ID port. */
export function committedRowAddress(row: Pick<HostLogRow, 'threadId' | 'seq'>): string {
  return JSON.stringify([row.threadId, row.seq]);
}

/** Projections reuse the accepted input command and root run; no message ID writer. */
export function committedRunIdentity(
  rows: readonly HostLogRow[],
  runId: string
): CommittedRunIdentity {
  const started = rows.find((row) => row.event.type === 'run.started' && row.event.runId === runId);
  if (started?.event.type !== 'run.started' || started.ts === undefined) {
    throw new Error('Run identity requires its committed start and SQLite timestamp');
  }
  const accepted = rows.filter(
    (row) =>
      row.threadId === started.threadId &&
      row.seq < started.seq &&
      row.event.type === 'command.accepted' &&
      row.event.method === 'run/start' &&
      row.event.result !== null &&
      typeof row.event.result === 'object' &&
      !Array.isArray(row.event.result) &&
      row.event.result['runId'] === runId
  );
  const command = accepted[0]?.event;
  if (accepted.length !== 1 || command?.type !== 'command.accepted') {
    throw new Error('Run identity requires one committed start command');
  }
  const payload = command.payload;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload['threadId'] !== started.threadId ||
    payload['modelId'] !== started.event.modelId ||
    payload['prompt'] !== started.event.prompt
  ) {
    throw new Error('Run start does not match its committed command');
  }
  return {
    assistantMessageId: runId,
    createdAt: new Date(started.ts),
    parentMessageId: previousCommittedMessage(rows, started),
    userMessageId: command.commandId,
  };
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
