import type { VisibleRow, VisibleSplice } from './lazy-tree-protocol';

/** Immutable apply; returns a new array. */
export function applySplicesImmutable<T>(
  source: T[],
  splices: (VisibleSplice & { items: T[] })[]
): T[] {
  if (!splices.length) return source.slice();
  // Ensure ascending index
  const sorted = splices.slice().sort((a, b) => a.index - b.index);
  const out: T[] = [];
  let cursor = 0;

  for (const s of sorted) {
    if (s.index < 0 || s.index > source.length) continue; // guard
    // Copy from cursor up to splice.start
    if (cursor < s.index) out.push(...source.slice(cursor, s.index));
    // Insert new items
    if (s.items?.length) out.push(...s.items);
    // Advance cursor past deleted region
    cursor = Math.min(source.length, s.index + Math.max(0, s.deleteCount));
  }
  // Tail
  if (cursor < source.length) out.push(...source.slice(cursor));
  return out;
}

/** In-place apply. */
export function applySplicesInPlace<T>(arr: T[], splices: (VisibleSplice & { items: T[] })[]) {
  // Apply from last to first to keep indexes stable
  const sorted = splices.slice().sort((a, b) => b.index - a.index);
  for (const s of sorted) {
    (arr as unknown as T[]).splice(s.index, s.deleteCount, ...(s.items ?? []));
  }
}

/** Broadcast to your existing test/event surfaces. */
export function dispatchVisibleRowsUpdated(rows: VisibleRow[]) {
  try {
    const paths = rows.map((r) => r.path);
    // app-visible snapshot for E2E assertions (you already typed these globals)
    (window as unknown as { __v2VisibleRowsPaths?: string[] }).__v2VisibleRowsPaths = paths;

    // test counter bump (if defined)
    const maybeTest = (window as unknown as { feTest?: { bumpVisibleRecalc?: () => void } }).feTest;
    if (typeof maybeTest?.bumpVisibleRecalc === 'function') {
      maybeTest.bumpVisibleRecalc();
    }

    // public event for any listeners
    window.dispatchEvent(
      new CustomEvent('v2-visible-rows-updated', { detail: { paths } as unknown })
    );
  } catch {
    // noop
  }
}
