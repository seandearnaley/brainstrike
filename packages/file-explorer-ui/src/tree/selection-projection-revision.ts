interface SelectionProjectionRevisionSnapshot {
  folderId: string | null;
  paths: ReadonlySet<string>;
  revision: number;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Provider-local, monotonic revision over the effective root-scoped selection.
 * Reads are O(N) in the bounded selection projection and value-based, so a
 * replacement Set with identical paths is a true no-op.
 */
export function createSelectionProjectionRevisionTracker(): {
  read: (folderId: string | null, paths: Iterable<string>) => number;
} {
  let snapshot: SelectionProjectionRevisionSnapshot | null = null;
  return {
    read: (folderId, paths) => {
      const nextPaths = new Set(paths);
      if (!snapshot) {
        snapshot = { folderId, paths: nextPaths, revision: 0 };
        return 0;
      }
      if (snapshot.folderId === folderId && setsEqual(snapshot.paths, nextPaths)) {
        return snapshot.revision;
      }
      snapshot = {
        folderId,
        paths: nextPaths,
        revision: snapshot.revision + 1,
      };
      return snapshot.revision;
    },
  };
}
