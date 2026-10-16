/**
 * How Core encodes a host event for its run log, with no Node module, so the
 * browser records a run as the host does (BST-1940): its spooled large text,
 * its run snapshot blob and its hydration mark.
 */
import type { AppendItem, BlobContent } from '@brainstrike/state-store';
import { largeText } from '@brainstrike/state-store/large-text';
import { sha256Hex } from '@brainstrike/utils/crypto';
import { z } from 'zod';
import { type HostEvent, HostEventSchema } from './protocol.js';

/**
 * ADR-0011 amendment: a committed run.started keeps its run snapshot (the run
 * configuration: system prompt, child system, captured intent, tool
 * identities) as one content-addressed blob, which every run of the same
 * configuration shares through the store's blob references. The row keeps the
 * snapshot's hash; reading the row resolves it to the exact snapshot the run
 * committed.
 */
export function storedRunSnapshot(event: HostEvent): {
  readonly blobs: readonly BlobContent[];
  readonly body: Readonly<Record<string, unknown>> & { readonly type: string };
} {
  if (event.type !== 'run.started' || event.snapshot === undefined) {
    return { blobs: [], body: event };
  }
  const { snapshot, ...started } = event;
  const content = JSON.stringify(snapshot);
  const hash = sha256Hex(content);
  return { blobs: [{ content, hash }], body: { ...started, blobRefs: [hash], snapshotRef: hash } };
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
