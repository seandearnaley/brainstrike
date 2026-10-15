import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BLOBS_DIR, type BlobContent, sha256Hex } from '@brainstrike/state-store';
import { decodeRunSnapshot } from './host-event-decoding.js';
import type { HostEvent, HostRunSnapshot } from './protocol.js';

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

export { takeRunSnapshotRef } from './host-event-decoding.js';

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
      readFile(join(root, BLOBS_DIR, hash)).then((bytes) => decodeRunSnapshot(hash, bytes))
    )
  );
}

/** For a synchronous reader (the state projection); it neither awaits nor fills the cache. */
export function readRunSnapshotSync(root: string, hash: string): HostRunSnapshot {
  return decodeRunSnapshot(hash, readFileSync(join(root, BLOBS_DIR, hash)));
}
