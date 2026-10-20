interface Preparation {
  prepareClose(): Promise<void>;
}

/** Producers finish while their catalog and mounted dependencies remain available. */
export async function prepareMainCatalogClose(
  roots: Preparation,
  worktrees: Preparation | null,
  catalog: Preparation
): Promise<void> {
  const failures: unknown[] = [];
  for (const owner of [roots, worktrees, catalog]) {
    if (!owner) {
      continue;
    }
    try {
      await owner.prepareClose();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Main catalog close preparation failed');
  }
}
