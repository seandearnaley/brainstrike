/**
 * Decoding a committed host row, wherever it is read: the desktop's Core and
 * state projection, and the browser state writer (BST-1940). The caller owns
 * blob IO and supplies the bytes: a spooled body's blob, and a resolver from a
 * run snapshot reference to its committed snapshot. Nothing here imports a
 * Node module.
 */
import { sha256Hex } from '@brainstrike/utils/crypto';
import { Schema } from 'effect';
import { storedJson } from './json-value.js';
import {
  type HostEvent,
  type HostRunSnapshot,
  hostEventSchema,
  hostRunSnapshotSchema,
} from './protocol.js';
import { Sha256 } from './workspace-wire.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** A stored body's run snapshot reference, removed from the body it came with. */
export function takeRunSnapshotRef(body: Readonly<Record<string, unknown>>): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly ref?: string;
} {
  if (!('snapshotRef' in body)) {
    return { body };
  }
  const { blobRefs, snapshotRef, ...rest } = body;
  const ref = Schema.decodeUnknownSync(Sha256)(snapshotRef);
  if (body['type'] !== 'run.started' || JSON.stringify(blobRefs) !== JSON.stringify([ref])) {
    throw new Error('Committed run snapshot reference does not match its row');
  }
  return { body: rest, ref };
}
/** Deep-frozen: one resolved snapshot is shared by every run that references it. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      frozen(child);
    }
    Object.freeze(value);
  }
  return value;
}
/** A snapshot blob is stored JSON, like a stored row (ADR-0011). */
const StoredRunSnapshotSchema = hostRunSnapshotSchema(storedJson);
/** A run snapshot blob's committed snapshot: verified against its hash, then decoded and deep-frozen. */
export function decodeRunSnapshot(hash: string, bytes: Uint8Array): HostRunSnapshot {
  if (sha256Hex(bytes) !== hash) {
    throw new Error('Committed run snapshot blob is damaged');
  }
  return frozen(
    Schema.decodeUnknownSync(StoredRunSnapshotSchema, { onExcessProperty: 'error' })(
      JSON.parse(utf8.decode(bytes))
    )
  );
}
const Spool = Schema.Struct({
  blob: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  blobRefs: Schema.optional(
    Schema.mutable(Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))))
  ),
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  preview: Schema.String,
  runId: Schema.optional(Schema.String),
  type: Schema.String,
});
export function hostEventSpool(
  stored: Readonly<Record<string, unknown>>
): (typeof Spool)['Type'] | undefined {
  return 'blob' in stored ? Schema.decodeUnknownSync(Spool)(stored) : undefined;
}
/** Stored rows' events, over stored JSON values (ADR-0011). */
const StoredHostEventSchema = hostEventSchema(storedJson);
/** A stored row's body: the row itself, or the JSON of the blob it spooled to. */
export function storedHostBody(
  stored: Readonly<Record<string, unknown>>,
  blob?: Uint8Array
): Readonly<Record<string, unknown>> {
  const spool = hostEventSpool(stored);
  if (!spool) {
    return stored;
  }
  if (!(blob && blob.byteLength === spool.bytes && sha256Hex(blob) === spool.blob)) {
    throw new Error('Committed host event blob is damaged');
  }
  const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(utf8.decode(blob))
  );
  if (body['type'] !== spool.type || body['runId'] !== spool.runId) {
    throw new Error('Committed host event blob identity does not match its row');
  }
  if (JSON.stringify(body['blobRefs'] ?? []) !== JSON.stringify(spool.blobRefs ?? [])) {
    throw new Error('Committed host event blob references do not match its row');
  }
  return body;
}
/**
 * Shared producer decoder; the caller owns asynchronous or worker-local blob
 * IO, including resolving a run snapshot reference to its committed snapshot.
 */
export function decodeStoredHostEvent(
  stored: Readonly<Record<string, unknown>>,
  blob?: Uint8Array,
  snapshot?: (hash: string) => HostRunSnapshot
): HostEvent {
  const { body, ref } = takeRunSnapshotRef(storedHostBody(stored, blob));
  const event = Schema.decodeUnknownSync(StoredHostEventSchema, { onExcessProperty: 'error' })(
    body
  );
  if (ref === undefined) {
    return event;
  }
  if (!snapshot) {
    throw new Error('A committed run snapshot reference needs its blob reader');
  }
  return { ...event, snapshot: snapshot(ref) } as HostEvent;
}
