import type { HostEvent, HostLogRow } from './protocol.js';

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

/** Canonical source rows, independent of a projection's timestamp requirement. */
export function committedRunSource(
  rows: readonly HostLogRow[],
  runId: string
): {
  readonly started: HostLogRow & { readonly event: Extract<HostEvent, { type: 'run.started' }> };
  readonly accepted: HostLogRow & {
    readonly event: Extract<HostEvent, { type: 'command.accepted' }>;
  };
} {
  const started = rows.find(
    (row): row is HostLogRow & { event: Extract<HostEvent, { type: 'run.started' }> } =>
      row.event.type === 'run.started' && row.event.runId === runId
  );
  if (!started) {
    throw new Error('Run identity requires its committed start');
  }
  const accepted = rows.filter(
    (row): row is HostLogRow & { event: Extract<HostEvent, { type: 'command.accepted' }> } =>
      row.threadId === started.threadId &&
      row.seq < started.seq &&
      row.event.type === 'command.accepted' &&
      row.event.method === 'run/start' &&
      row.event.result !== null &&
      typeof row.event.result === 'object' &&
      !Array.isArray(row.event.result) &&
      row.event.result['runId'] === runId
  );
  const acceptance = accepted[0];
  if (accepted.length !== 1 || !acceptance) {
    throw new Error('Run identity requires one committed start command');
  }
  const command = acceptance.event;
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
  return { accepted: acceptance, started };
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
  return {
    assistantMessageId: runId,
    createdAt: new Date(started.ts),
    parentMessageId: previousCommittedMessage(rows, started),
    userMessageId: accepted.event.commandId,
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
