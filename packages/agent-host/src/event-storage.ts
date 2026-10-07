import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppendItem,
  BLOBS_DIR,
  type LogRow,
  largeText,
  type StateStore,
  sha256Hex,
} from '@brainstrike/state-store';
import { z } from 'zod';
import { type HostEvent, HostEventSchema, type HostLogRow } from './protocol.js';

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

/** Shared producer decoder; the caller owns asynchronous or worker-local blob IO. */
export function decodeStoredHostEvent(
  stored: Readonly<Record<string, unknown>>,
  blob?: Uint8Array
): HostEvent {
  const spool = hostEventSpool(stored);
  if (!spool) {
    return HostEventSchema.parse(stored);
  }
  if (!(blob && blob.byteLength === spool.bytes && sha256Hex(Buffer.from(blob)) === spool.blob)) {
    throw new Error('Committed host event blob is damaged');
  }
  const event = HostEventSchema.parse(JSON.parse(Buffer.from(blob).toString('utf8')));
  if (event.type !== spool.type || ('runId' in event ? event.runId : undefined) !== spool.runId) {
    throw new Error('Committed host event blob identity does not match its row');
  }
  return event;
}

/** Keep the existing event kind/run ID; StateStore owns blob durability and reference counting. */
export function storedHostEvent(threadId: string, input: HostEvent): AppendItem {
  const event = HostEventSchema.parse(input);
  const stored = largeText(JSON.stringify(event));
  if (!stored.blob) {
    return { event, threadId };
  }
  return {
    blobs: [stored.blob],
    event: {
      type: event.type,
      ...('runId' in event ? { runId: event.runId } : {}),
      ...stored.fields,
    },
    threadId,
  };
}

export async function readHostRow(
  store: Pick<StateStore, 'root'>,
  row: LogRow
): Promise<HostLogRow> {
  const { seq: _storedSeq, ...stored } = row.event;
  const spool = hostEventSpool(stored);
  const event = decodeStoredHostEvent(
    stored,
    spool ? await readFile(join(store.root, BLOBS_DIR, spool.blob)) : undefined
  );
  return {
    event,
    seq: row.seq,
    threadId: row.threadId,
    ...(row.ts === undefined ? {} : { ts: row.ts }),
  };
}
