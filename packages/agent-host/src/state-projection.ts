import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOBS_DIR,
  type Mode,
  type Purged,
  UnknownEventError,
  type Unreadable,
} from '@brainstrike/state-store';
import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import { committedRowAddress, committedRunSource } from './committed-identities.js';
import { decodeStoredHostEvent, hostEventSpool } from './event-storage.js';
import { type HostEvent, HostEventSchema, type HostLogRow, HostLogRowSchema } from './protocol.js';

export { observationChunks, observations } from './observation-projection.js';

type DecodedHostEvent = (HostEvent & { readonly seq: number }) | Purged | Unreadable;
const sequence = z.number().int().positive();
const fields = z.record(z.string(), z.unknown());

/** BST-1977: Core truth is unversioned. Decode its actual producer shape unchanged. */
export function decode(raw: string, mode: Mode, stateRoot?: string): DecodedHostEvent {
  let seq = -1;
  try {
    const stored = fields.parse(JSON.parse(raw));
    seq = sequence.parse(stored['seq']);
    const { seq: _storedSequence, ...body } = stored;
    if (body['type'] === 'purged') {
      return { seq, type: 'purged' };
    }
    const spool = hostEventSpool(body);
    if (spool && !stateRoot) {
      throw new Error('Host blob projection requires its acquired truth root');
    }
    const event = decodeStoredHostEvent(
      body,
      spool && stateRoot ? readFileSync(join(stateRoot, BLOBS_DIR, spool.blob)) : undefined
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
  const record = fields.parse(input);
  if (record['type'] === 'purged' || record['type'] === 'unreadable') {
    return undefined;
  }
  const { seq: _storedSequence, ...event } = record;
  return HostEventSchema.parse(event);
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
    case 'effect.finished':
      return JSON.stringify(event.output);
    default:
      return null;
  }
}

/** Existing command and row addresses; no vendor IDs, timestamp guesses or ID writer. */
export function messages(
  input: readonly { readonly threadId: string; readonly seq: number; readonly event: unknown }[]
): readonly { readonly messageId: string; readonly seq: number }[] {
  const rows: HostLogRow[] = input.flatMap((row) => {
    const event = projectedEvent(row.event);
    return event ? [HostLogRowSchema.parse({ event, seq: row.seq, threadId: row.threadId })] : [];
  });
  const selected: { messageId: string; seq: number }[] = [];
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
      const { accepted } = committedRunSource(rows, row.event.runId);
      append(accepted.event.commandId, row.seq);
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
