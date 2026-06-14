const MULTI_ROOT_RESOURCE_PREFIX = 'assistant-workspace:roots:';

function normalizeRootIds(activeRootIds: readonly string[] | null | undefined): string[] {
  const rootIds = new Set<string>();
  if (!activeRootIds) {
    return [];
  }
  for (const rootId of activeRootIds) {
    const trimmed = rootId.trim();
    if (trimmed.length > 0) {
      rootIds.add(trimmed);
    }
  }
  return Array.from(rootIds).sort();
}

export function resolveAssistantWorkspaceResourceId(args: {
  activeRootIds: readonly string[] | null | undefined;
  rootDirectoryPath: string | null | undefined;
}): string | null {
  const normalizedRootIds = normalizeRootIds(args.activeRootIds);
  if (normalizedRootIds.length > 1) {
    return `${MULTI_ROOT_RESOURCE_PREFIX}${normalizedRootIds.map(encodeURIComponent).join('|')}`;
  }
  return args.rootDirectoryPath ?? null;
}
