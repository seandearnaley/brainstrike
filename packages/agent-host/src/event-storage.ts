import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import {
  type AppendItem,
  BLOBS_DIR,
  type BlobContent,
  type LogRow,
  largeText,
  type StateStore,
} from '@brainstrike/state-store';
import { z } from 'zod';
import { decodeStoredHostEvent, hostEventSpool, storedHostBody } from './host-event-decoding.js';
import { type HostEvent, HostEventSchema, type HostLogRow } from './protocol.js';
import { readRunSnapshot, storedRunSnapshot, takeRunSnapshotRef } from './run-snapshot-blobs.js';

export async function readHostThreadHistory(
  store: Pick<StateStore, 'read' | 'root'>,
  threads: ReadonlySet<string>,
  threadId: string,
  fromSeq: number
): Promise<HostLogRow[]> {
  if (!threads.has(threadId)) {
    throw refusalError('input', 'thread.unknown', 'Unknown thread');
  }
  return Promise.all(
    (await store.read(threadId, fromSeq + 1)).map((row) => readHostRow(store, row))
  );
}

export { decodeStoredHostEvent, hostEventSpool, storedHostBody };

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
