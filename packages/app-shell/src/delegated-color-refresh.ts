const listeners = new Set<() => void>();
let revision = 0;

export function subscribeDelegatedColorRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDelegatedColorRevision(): number {
  return revision;
}

/** Re-read visible saved identities after an explicit color refresh commits. */
export function publishDelegatedColorRefresh(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}
