import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { BLOBS_DIR, type LogRow, type StateStore } from '@brainstrike/state-store';
import { decodeStoredHostEvent, hostEventSpool, storedHostBody } from './host-event-decoding.ts';
import type { HostLogRow } from './protocol.ts';
import { readRunSnapshot, takeRunSnapshotRef } from './run-snapshot-blobs.ts';
import type { HostRowReader } from './thread-catalog.ts';

/** Desktop's row reader for the thread catalog: blobs from the store's data root. */
export function nodeHostRowReader(store: Pick<StateStore, 'read' | 'root'>): HostRowReader {
  return {
    readHistory: (threads, threadId, fromSeq) =>
      readHostThreadHistory(store, threads, threadId, fromSeq),
    readRow: (row) => readHostRow(store, row),
  };
}

async function readHostThreadHistory(
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

export { storedHostEvent } from './host-event-encoding.ts';
export { decodeStoredHostEvent };

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
