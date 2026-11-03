/**
 * The folder mounts in flight, by the path asked for, and why the last one failed. A file tab
 * reads these to tell a folder that is opening from one that is closed or cannot open: only a
 * request for that folder's own path makes it "opening", never another folder's change.
 */
export interface FolderRequests {
  /** Paths whose last mount failed, with the reason the platform gave. */
  readonly failures: ReadonlyMap<string, string>;
  /** Paths with a mount in flight, and how many. */
  readonly opening: ReadonlyMap<string, number>;
}

export const NO_FOLDER_REQUESTS: FolderRequests = { failures: new Map(), opening: new Map() };

export type FolderRequestOutcome = 'started' | 'settled' | { readonly failure: string };

export function nextFolderRequests(
  requests: FolderRequests,
  path: string,
  outcome: FolderRequestOutcome
): FolderRequests {
  const opening = new Map(requests.opening);
  const failures = new Map(requests.failures);
  const inFlight = opening.get(path) ?? 0;
  if (outcome === 'started') {
    opening.set(path, inFlight + 1);
    failures.delete(path);
    return { failures, opening };
  }
  if (inFlight > 1) {
    opening.set(path, inFlight - 1);
  } else {
    opening.delete(path);
  }
  if (outcome === 'settled') {
    failures.delete(path);
  } else {
    failures.set(path, outcome.failure);
  }
  return { failures, opening };
}
