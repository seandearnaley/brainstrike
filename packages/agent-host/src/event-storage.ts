import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppendItem,
  BLOBS_DIR,
  type BlobContent,
  type LogRow,
  largeText,
  type StateStore,
  sha256Hex,
} from '@brainstrike/state-store';
import { z } from 'zod';
import { storedJson } from './json-value.js';
import {
  type HostEvent,
  HostEventSchema,
  type HostLogRow,
  type HostRunSnapshot,
  hostEventSchema,
} from './protocol.js';
import { readRunSnapshot, storedRunSnapshot, takeRunSnapshotRef } from './run-snapshot-blobs.js';

export async function readHostThreadHistory(
  store: Pick<StateStore, 'read' | 'root'>,
  threads: ReadonlySet<string>,
  threadId: string,
  fromSeq: number
): Promise<HostLogRow[]> {
  if (!threads.has(threadId)) {
    throw new Error('Unknown thread');
  }
  return Promise.all(
    (await store.read(threadId, fromSeq + 1)).map((row) => readHostRow(store, row))
  );
}

const Spool = z.object({
  blob: z.string().regex(/^[a-f0-9]{64}$/u),
  blobRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  bytes: z.number().int().positive(),
  preview: z.string(),
  runId: z.string().optional(),
  type: z.string(),
});

export function hostEventSpool(
  stored: Readonly<Record<string, unknown>>
): z.output<typeof Spool> | undefined {
  return 'blob' in stored ? Spool.parse(stored) : undefined;
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
  if (!(blob && blob.byteLength === spool.bytes && sha256Hex(Buffer.from(blob)) === spool.blob)) {
    throw new Error('Committed host event blob is damaged');
  }
  const body = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(blob).toString('utf8')));
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
  const event = StoredHostEventSchema.parse(body);
  if (ref === undefined) {
    return event;
  }
  if (!snapshot) {
    throw new Error('A committed run snapshot reference needs its blob reader');
  }
  return { ...event, snapshot: snapshot(ref) } as HostEvent;
}

/**
 * The streamed chunk kinds Core's open folds: the ledger's tool-call and tool-error counts
 * (ledger-projection.ts countToolChunk). Every other chunk is the thread view's alone.
 */
const HYDRATED_CHUNK_TYPES: ReadonlySet<unknown> = new Set(['tool-call', 'tool-error']);

/** `false` when no fold of Core's open reads the event, so the hydration read skips its row. */
export function hydratesHostEvent(event: HostEvent): boolean {
  if (event.type !== 'stream.chunk') {
    return true;
  }
  const { chunk } = event;
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    !Array.isArray(chunk) &&
    HYDRATED_CHUNK_TYPES.has(chunk['type'])
  );
}

/**
 * Keep the existing event kind/run ID; StateStore owns blob durability and reference counting.
 * `referenced` are the blobs the event names in `blobRefs`; a spooled row keeps those names.
 */
export function storedHostEvent(
  threadId: string,
  input: HostEvent,
  referenced: readonly BlobContent[] = []
): AppendItem {
  const event = HostEventSchema.parse(input);
  const refs = 'blobRefs' in event ? (event.blobRefs ?? []) : [];
  const supplied = new Set(referenced.map((blob) => blob.hash));
  if (refs.length !== supplied.size || refs.some((hash) => !supplied.has(hash))) {
    throw new Error('Host event blob references do not match the supplied blobs');
  }
  const mark = hydratesHostEvent(event) ? {} : { hydrate: false as const };
  const { blobs: snapshot, body } = storedRunSnapshot(event);
  const blobs = [...snapshot, ...referenced];
  const bodyRefs = z.array(z.string()).parse(body['blobRefs'] ?? []);
  const stored = largeText(JSON.stringify(body));
  if (!stored.blob) {
    return { ...(blobs.length > 0 ? { blobs } : {}), event: body, ...mark, threadId };
  }
  return {
    blobs: [stored.blob, ...blobs],
    event: {
      type: event.type,
      ...('runId' in event ? { runId: event.runId } : {}),
      ...stored.fields,
      ...(bodyRefs.length > 0 ? { blobRefs: bodyRefs } : {}),
    },
    ...mark,
    threadId,
  };
}

export async function readHostRow(
  store: Pick<StateStore, 'root'>,
  row: LogRow
): Promise<HostLogRow> {
  const { seq: _storedSeq, ...stored } = row.event;
  const spool = hostEventSpool(stored);
  const body = storedHostBody(
    stored,
    spool ? await readFile(join(store.root, BLOBS_DIR, spool.blob)) : undefined
  );
  const ref = takeRunSnapshotRef(body).ref;
  const snapshot = ref === undefined ? undefined : await readRunSnapshot(store.root, ref);
  const event = decodeStoredHostEvent(body, undefined, snapshot && (() => snapshot));
  return {
    event,
    seq: row.seq,
    threadId: row.threadId,
    ...(row.ts === undefined ? {} : { ts: row.ts }),
  };
}
