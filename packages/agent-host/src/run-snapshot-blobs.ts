import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BLOBS_DIR, type BlobContent, sha256Hex } from '@brainstrike/state-store';
import { storedJson } from './json-value.js';
import { type HostEvent, type HostRunSnapshot, hostRunSnapshotSchema } from './protocol.js';
import { Sha256 } from './workspace-wire.js';

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

/** A stored body's run snapshot reference, removed from the body it came with. */
export function takeRunSnapshotRef(body: Readonly<Record<string, unknown>>): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly ref?: string;
} {
  if (!('snapshotRef' in body)) {
    return { body };
  }
  const { blobRefs, snapshotRef, ...rest } = body;
  const ref = Sha256.parse(snapshotRef);
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

function decodeSnapshot(hash: string, bytes: Uint8Array): HostRunSnapshot {
  if (sha256Hex(Buffer.from(bytes)) !== hash) {
    throw new Error('Committed run snapshot blob is damaged');
  }
  return frozen(StoredRunSnapshotSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))));
}

/**
 * Resolved snapshots by store root and content hash. Blobs are immutable, so a
 * hash resolves once per process; the bound keeps a long-lived process from
 * holding every configuration it ever saw.
 */
const RESOLVED_LIMIT = 256;
const resolved = new Map<string, Promise<HostRunSnapshot>>();

function remember(key: string, snapshot: Promise<HostRunSnapshot>): Promise<HostRunSnapshot> {
  resolved.set(key, snapshot);
  // A rejection (a missing or damaged blob) is never cached.
  snapshot.catch(() => resolved.delete(key));
  if (resolved.size > RESOLVED_LIMIT) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) {
      resolved.delete(oldest);
    }
  }
  return snapshot;
}

export function readRunSnapshot(root: string, hash: string): Promise<HostRunSnapshot> {
  const key = `${root}\0${hash}`;
  return (
    resolved.get(key) ??
    remember(
      key,
      readFile(join(root, BLOBS_DIR, hash)).then((bytes) => decodeSnapshot(hash, bytes))
    )
  );
}

/** For a synchronous reader (the state projection); it neither awaits nor fills the cache. */
export function readRunSnapshotSync(root: string, hash: string): HostRunSnapshot {
  return decodeSnapshot(hash, readFileSync(join(root, BLOBS_DIR, hash)));
}
