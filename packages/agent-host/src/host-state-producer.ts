/**
 * The host's state producer: how the derived index reads committed host rows
 * (ADR-0011). It decodes a row, and projects its history text, search row and
 * message identities. The caller supplies blob reads. The desktop's producer
 * module (`state-projection.ts`) reads the data root's blob files; the browser
 * state writer (BST-1940) reads its own blob store. Nothing here imports a
 * Node module.
 */
import {
  type Mode,
  type Purged,
  UnknownEventError,
  type Unreadable,
} from '@brainstrike/state-store/event-schema';
import { modelMessageSchema } from 'ai';
import { Schema } from 'effect';
import { committedRowAddress, committedRunSource } from './committed-identities.js';
import { decodeRunSnapshot, decodeStoredHostEvent, hostEventSpool } from './host-event-decoding.js';
import { type HostEvent, HostEventSchema, type HostLogRow, HostLogRowSchema } from './protocol.js';
export type DecodedHostEvent =
  | (HostEvent & {
      readonly seq: number;
    })
  | Purged
  | Unreadable;
/** A committed blob's bytes by content hash; it throws when the blob cannot be read. */
export type HostBlobRead = (hash: string) => Uint8Array;
const sequence = Schema.Int.check(Schema.isGreaterThan(0));
const fields = Schema.Record(Schema.String, Schema.Unknown);
/**
 * BST-1977: Core truth is unversioned. Decode its actual producer shape
 * unchanged. A row that spooled its body or names a run snapshot needs
 * `readBlob`; without it the row is refused.
 */
export function decodeHostRow(raw: string, mode: Mode, readBlob?: HostBlobRead): DecodedHostEvent {
  let seq = -1;
  try {
    const stored = Schema.decodeUnknownSync(fields, { errors: 'all', onExcessProperty: 'error' })(
      JSON.parse(raw)
    );
    seq = Schema.decodeUnknownSync(sequence, { errors: 'all', onExcessProperty: 'error' })(
      stored['seq']
    );
    const { seq: _storedSequence, ...body } = stored;
    if (body['type'] === 'purged') {
      return { seq, type: 'purged' };
    }
    const spool = hostEventSpool(body);
    if ((spool || 'snapshotRef' in body) && !readBlob) {
      throw new Error('Host blob projection requires its acquired truth root');
    }
    const event = decodeStoredHostEvent(
      body,
      spool && readBlob ? readBlob(spool.blob) : undefined,
      readBlob ? (hash) => decodeRunSnapshot(hash, readBlob(hash)) : undefined
    );
    return { ...event, seq };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (mode === 'dev') {
      throw new UnknownEventError(seq, reason);
    }
    return { raw, reason, seq, type: 'unreadable' };
  }
}
function projectedEvent(input: unknown): HostEvent | undefined {
  const record = Schema.decodeUnknownSync(fields, { errors: 'all', onExcessProperty: 'error' })(
    input
  );
  if (record['type'] === 'purged' || record['type'] === 'unreadable') {
    return undefined;
  }
  const { seq: _storedSequence, ...event } = record;
  return Schema.decodeUnknownSync(HostEventSchema, { errors: 'all', onExcessProperty: 'error' })(
    event
  );
}
/**
 * A tool payload's string values, one per line. Indexing its JSON text would
 * glue escapes onto words: unicode61 reads `\ntool` as the token `ntool`.
 */
function payloadText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(payloadText).filter(Boolean).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return payloadText(Object.values(value));
  }
  return '';
}
/** Visible tool/decision history belongs to the run's existing assistant message. */
function runHistoryText(event: HostEvent): string | null {
  switch (event.type) {
    case 'effect.finished':
      return payloadText(event.output) || null;
    case 'interaction.requested':
      return `${event.kind} ${event.toolId}\n${payloadText(event.input)}`;
    case 'interaction.responded':
      return 'decision' in event ? event.decision : payloadText(event.resumeData) || null;
    case 'run.finished':
      return event.detail ? `${event.outcome} ${event.detail}` : null;
    default:
      return null;
  }
}
/** Recognized committed content only; metadata and gaps contribute no FTS text. */
export function text(input: unknown): string | null {
  const event = projectedEvent(input);
  if (!event) {
    return null;
  }
  switch (event.type) {
    case 'run.started':
      return event.prompt;
    case 'model.step':
    case 'model.messages':
      return event.messages.length > 0 ? JSON.stringify(event.messages) : null;
    default:
      return runHistoryText(event);
  }
}
/** An assistant message's own text parts; tool calls, results and reasoning are not conversation text. */
function assistantText(message: unknown): string[] {
  const parsed = modelMessageSchema.parse(message);
  if (parsed.role !== 'assistant') {
    return [];
  }
  if (typeof parsed.content === 'string') {
    return [parsed.content];
  }
  return parsed.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
}
/**
 * Committed history under the message the UI already renders: a typed prompt,
 * assistant text, tool result, decision or terminal diagnostic. Regeneration
 * and wake prompts do not introduce another user message.
 */
export function search(input: unknown): {
  readonly role: 'assistant' | 'user';
  readonly runId: string;
  readonly text: string;
} | null {
  const event = projectedEvent(input);
  if (event?.type === 'run.started') {
    const typed = event.userMessageId === undefined && event.delivery?.via !== 'wake';
    return typed && event.prompt.trim()
      ? { role: 'user', runId: event.runId, text: event.prompt }
      : null;
  }
  if (!(event && 'runId' in event)) {
    return null;
  }
  const text =
    event.type === 'model.step' || event.type === 'model.messages'
      ? event.messages.flatMap(assistantText).join('\n').trim()
      : runHistoryText(event);
  return text ? { role: 'assistant', runId: event.runId, text } : null;
}
/** Existing command and row addresses; no vendor IDs, timestamp guesses or ID writer. */
export function messages(
  input: readonly {
    readonly threadId: string;
    readonly seq: number;
    readonly event: unknown;
  }[]
): readonly {
  readonly messageId: string;
  readonly seq: number;
}[] {
  const rows: HostLogRow[] = input.flatMap((row) => {
    const event = projectedEvent(row.event);
    return event
      ? [
          Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
            event,
            seq: row.seq,
            threadId: row.threadId,
          }),
        ]
      : [];
  });
  const selected: {
    messageId: string;
    seq: number;
  }[] = [];
  const ids = new Set<string>();
  const append = (messageId: string, seq: number): void => {
    if (ids.has(messageId)) {
      throw new Error('Committed conversation identities collide');
    }
    ids.add(messageId);
    selected.push({ messageId, seq });
  };
  for (const row of rows) {
    if (row.event.type === 'run.started') {
      const { admissionId } = committedRunSource(rows, row.event.runId);
      // A regeneration answers its committed user message again; it adds no message.
      if (row.event.userMessageId === undefined) {
        append(admissionId, row.seq);
      }
      for (const segment of rows) {
        const event = segment.event;
        if (
          segment.threadId !== row.threadId ||
          (event.type !== 'model.step' && event.type !== 'model.messages') ||
          event.runId !== row.event.runId ||
          event.messages.length === 0
        ) {
          continue;
        }
        for (const message of event.messages) {
          modelMessageSchema.parse(message);
        }
        append(committedRowAddress(segment), segment.seq);
      }
    }
  }
  return selected;
}
