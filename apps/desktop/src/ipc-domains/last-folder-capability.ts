interface RootEntry {
  readonly path: string;
  readonly rootId: string;
}

interface MountedEntry {
  readonly canonicalPath: string;
  readonly newlyMounted: boolean;
}

interface MountLastFolderCapabilityOptions<TEntry extends RootEntry> {
  readonly entries: readonly TEntry[];
  readonly existing: TEntry | undefined;
  readonly initialEntry: TEntry;
  readonly mountIfNeeded: (entry: TEntry) => Promise<MountedEntry>;
  readonly newlyMountedRootIds: Set<string>;
  readonly unmountRoot: (rootId: string) => void;
}

export async function mountLastFolderCapability<TEntry extends RootEntry>({
  entries,
  existing,
  initialEntry,
  mountIfNeeded,
  newlyMountedRootIds,
  unmountRoot,
}: MountLastFolderCapabilityOptions<TEntry>): Promise<{
  canonicalPath: string;
  entry: TEntry;
  supersededPreexistingRootId?: string;
}> {
  const initialMounted = await mountIfNeeded(initialEntry);
  if (initialMounted.newlyMounted) {
    newlyMountedRootIds.add(initialEntry.rootId);
  }
  const canonicalExisting =
    entries.find((candidate) => candidate.path === initialMounted.canonicalPath) ?? existing;
  if (!canonicalExisting || canonicalExisting.rootId === initialEntry.rootId) {
    return { canonicalPath: initialMounted.canonicalPath, entry: initialEntry };
  }

  const initialWasNew = newlyMountedRootIds.delete(initialEntry.rootId);
  if (initialWasNew) {
    unmountRoot(initialEntry.rootId);
  }
  const canonicalMounted = await mountIfNeeded(canonicalExisting);
  if (canonicalMounted.newlyMounted) {
    newlyMountedRootIds.add(canonicalExisting.rootId);
  }
  return {
    canonicalPath: canonicalMounted.canonicalPath,
    entry: canonicalExisting,
    ...(initialWasNew ? {} : { supersededPreexistingRootId: initialEntry.rootId }),
  };
}
