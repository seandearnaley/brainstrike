export function normalizeWorkspaceLookupPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function buildWorkspaceLookupCandidates(paths: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const filePath of paths) {
    const normalized = normalizeWorkspaceLookupPath(filePath);
    if (normalized.length === 0) {
      continue;
    }
    candidates.add(normalized);
    candidates.add(`/${normalized}`);
  }
  return Array.from(candidates);
}
