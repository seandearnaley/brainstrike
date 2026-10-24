import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BLOBS_DIR } from '@brainstrike/state-store';
import { decodeRunSnapshot } from './host-event-decoding.ts';
import type { HostRunSnapshot } from './protocol.ts';

export { takeRunSnapshotRef } from './host-event-decoding.ts';

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
