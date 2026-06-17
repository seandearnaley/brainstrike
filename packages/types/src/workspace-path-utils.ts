export function normalizeWorkspaceLookupPath(value: string): string {
  let normalized = value.trim();
  const firstBackslash = normalized.indexOf('\\');
  if (firstBackslash !== -1) {
    let next = '';
    let segmentStart = 0;
    for (let index = firstBackslash; index < normalized.length; index += 1) {
      if (normalized.charCodeAt(index) !== 92) {
        continue;
      }
      next += `${normalized.slice(segmentStart, index)}/`;
      segmentStart = index + 1;
    }
    next += normalized.slice(segmentStart);
    normalized = next;
  }

  let start = 0;
  if (normalized.charCodeAt(0) === 46 && normalized.charCodeAt(1) === 47) {
    start = 2;
    while (normalized.charCodeAt(start) === 47) {
      start += 1;
    }
  }
  while (normalized.charCodeAt(start) === 47) {
    start += 1;
  }
  return start === 0 ? normalized : normalized.slice(start);
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
