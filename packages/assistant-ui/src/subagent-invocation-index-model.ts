import type { SubAgentToolRow, SubagentDelegationOutcome } from './subagent-tool-rows';
import { readSubagentRunEventContribution } from './subagent-tool-rows';

export interface SubagentInvocationSnapshot {
  readonly outcome?: SubagentDelegationOutcome;
  readonly rows: readonly SubAgentToolRow[];
}

interface IndexedMessage {
  readonly id: string;
  readonly invocations: Map<string, InvocationContribution>;
  parts: readonly unknown[];
  scanned: number;
  settled: boolean;
}

interface InvocationContribution {
  outcome?: SubagentDelegationOutcome;
  readonly rows: Map<string, SubAgentToolRow>;
}

interface IndexMessage {
  readonly id?: unknown;
  readonly parts?: readonly unknown[];
  readonly status?: unknown;
}

const EMPTY_SNAPSHOT: SubagentInvocationSnapshot = Object.freeze({ rows: Object.freeze([]) });
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSettled(status: unknown): boolean {
  return isRecord(status) && (status['type'] === 'complete' || status['type'] === 'incomplete');
}

function isMutableStreamingTail(previous: unknown, next: unknown): boolean {
  if (!(isRecord(previous) && isRecord(next) && previous['type'] === next['type'])) {
    return false;
  }
  return (
    previous['type'] === 'text' ||
    previous['type'] === 'reasoning' ||
    previous['type'] === 'tool-call'
  );
}

function retainedPartsAreCompatible(record: IndexedMessage, parts: readonly unknown[]): boolean {
  // Settled content is immutable during normal streaming. A new parts array
  // for the same settled id is an authoritative history replacement.
  if (record.settled && parts !== record.parts) {
    return false;
  }
  if (parts.length < record.scanned || parts === record.parts) {
    return parts.length >= record.scanned;
  }
  for (let index = 0; index < record.scanned; index += 1) {
    const previous = record.parts[index];
    const next = parts[index];
    if (previous === next) {
      continue;
    }
    const isTailUpdate =
      index === record.scanned - 1 &&
      parts.length === record.scanned &&
      isMutableStreamingTail(previous, next);
    if (!isTailUpdate) {
      return false;
    }
  }
  return true;
}

function equalRows(left: readonly SubAgentToolRow[], right: readonly SubAgentToolRow[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        row.argSummary === other.argSummary &&
        row.key === other.key &&
        row.status === other.status &&
        row.toolName === other.toolName
      );
    })
  );
}

function projectSnapshot(
  records: readonly IndexedMessage[],
  id: string
): SubagentInvocationSnapshot {
  const rows = new Map<string, SubAgentToolRow>();
  let outcome: SubagentDelegationOutcome | undefined;
  for (const record of records) {
    const contribution = record.invocations.get(id);
    if (!contribution) {
      continue;
    }
    outcome ??= contribution.outcome;
    for (const [key, row] of contribution.rows) {
      rows.set(
        key,
        record.settled && row.status === 'running' ? { ...row, status: 'interrupted' } : row
      );
    }
  }
  return { ...(outcome ? { outcome } : {}), rows: Array.from(rows.values()) };
}

function readMessage(message: IndexMessage): IndexedMessage {
  if (typeof message.id !== 'string') {
    throw new Error(
      'Subagent invocation index requires every thread message to have a stable string id'
    );
  }
  return {
    id: message.id,
    invocations: new Map(),
    parts: Array.isArray(message.parts) ? message.parts : [],
    scanned: 0,
    settled: isSettled(message.status),
  };
}

function foldPart(record: IndexedMessage, part: unknown): string | undefined {
  const event = readSubagentRunEventContribution(part);
  if (!event) {
    return;
  }
  const parent = event.parentToolCallId;
  let contribution = record.invocations.get(parent);
  if (!contribution) {
    contribution = { rows: new Map() };
    record.invocations.set(parent, contribution);
  }
  if (event.outcome && contribution.outcome === undefined) {
    contribution.outcome = event.outcome;
  }
  if (event.row) {
    contribution.rows.set(event.row.key, event.row);
  }
  return parent;
}

export interface SubagentInvocationIndex {
  advance(messages: readonly IndexMessage[]): void;
  getSnapshot(parentToolCallId: string): SubagentInvocationSnapshot;
  subscribe(parentToolCallId: string, listener: () => void): () => void;
}

export function createSubagentInvocationIndex(options?: {
  readonly inspect?: (part: unknown) => void;
}): SubagentInvocationIndex {
  let records: IndexedMessage[] = [];
  const snapshots = new Map<string, SubagentInvocationSnapshot>();
  const listeners = new Map<string, Set<() => void>>();

  const publish = (ids: ReadonlySet<string>) => {
    for (const id of ids) {
      const previous = snapshots.get(id) ?? EMPTY_SNAPSHOT;
      const next = projectSnapshot(records, id);
      if (previous.outcome === next.outcome && equalRows(previous.rows, next.rows)) {
        continue;
      }
      if (next.rows.length === 0 && next.outcome === undefined) {
        snapshots.delete(id);
      } else {
        snapshots.set(id, next);
      }
      for (const listener of listeners.get(id) ?? []) {
        listener();
      }
    }
  };

  const scan = (record: IndexedMessage, start: number, affected: Set<string>) => {
    for (let index = start; index < record.parts.length; index += 1) {
      const part = record.parts[index];
      options?.inspect?.(part);
      const parent = foldPart(record, part);
      if (parent) {
        affected.add(parent);
      }
    }
    record.scanned = record.parts.length;
  };

  const rebuild = (messages: readonly IndexMessage[]) => {
    const affected = new Set([...snapshots.keys()]);
    records = messages.map((message) => {
      const record = readMessage(message);
      scan(record, 0, affected);
      return record;
    });
    publish(affected);
  };

  const updateRecord = (
    record: IndexedMessage,
    message: IndexMessage,
    affected: Set<string>
  ): boolean => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (!retainedPartsAreCompatible(record, parts)) {
      return false;
    }
    const settled = isSettled(message.status);
    if (record.settled !== settled) {
      record.settled = settled;
      for (const id of record.invocations.keys()) {
        affected.add(id);
      }
    }
    record.parts = parts;
    scan(record, record.scanned, affected);
    return true;
  };

  return {
    advance(messages) {
      const topologyChanged =
        records.length > messages.length ||
        records.some((record, index) => record.id !== messages[index]?.id);
      if (topologyChanged) {
        rebuild(messages);
        return;
      }
      const affected = new Set<string>();
      for (let index = records.length; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message) {
          continue;
        }
        const record = readMessage(message);
        records.push(record);
        scan(record, 0, affected);
      }
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const record = records[index];
        if (!(message && record)) {
          continue;
        }
        if (!updateRecord(record, message, affected)) {
          rebuild(messages);
          return;
        }
      }
      publish(affected);
    },
    getSnapshot(parentToolCallId) {
      return snapshots.get(parentToolCallId) ?? EMPTY_SNAPSHOT;
    },
    subscribe(parentToolCallId, listener) {
      let own = listeners.get(parentToolCallId);
      if (!own) {
        own = new Set();
        listeners.set(parentToolCallId, own);
      }
      own.add(listener);
      return () => {
        own?.delete(listener);
        if (own?.size === 0) {
          listeners.delete(parentToolCallId);
        }
      };
    },
  };
}
