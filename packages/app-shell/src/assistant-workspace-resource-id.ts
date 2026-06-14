const MULTI_ROOT_RESOURCE_PREFIX = 'assistant-workspace:roots:';

function normalizeValues(values: readonly string[] | null | undefined): string[] {
  const normalized = new Set<string>();
  if (!values) {
    return [];
  }
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }
  return Array.from(normalized).sort();
}

export function resolveAssistantWorkspaceResourceId(args: {
  activeRootIds: readonly string[] | null | undefined;
  rootDirectoryPath: string | null | undefined;
  rootDirectoryPaths?: readonly string[] | null | undefined;
}): string | null {
  const normalizedRootIds = normalizeValues(args.activeRootIds);
  if (normalizedRootIds.length > 1) {
    const normalizedRootPaths = normalizeValues(args.rootDirectoryPaths);
    if (normalizedRootPaths.length !== normalizedRootIds.length) {
      return null;
    }
    return `${MULTI_ROOT_RESOURCE_PREFIX}${normalizedRootPaths.map(encodeURIComponent).join('|')}`;
  }
  return args.rootDirectoryPath ?? null;
}
