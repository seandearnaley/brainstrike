/**
 * Pure utility functions for synchronizing tapestry range state.
 *
 * Extracted from preview-panel.tsx to reduce component module size
 * and improve testability of range clamping/sync logic.
 */

import type { buildTapestryFileBase } from '../tapestry/tapestry-adapter';
import type { TapestryRange } from '../tapestry/types';
import type { TapestryRangeMap } from './context-selected-token-summary';

function clampRangeToTotal(range: TapestryRange, totalLines: number): TapestryRange {
  if (totalLines <= 0) {
    return range;
  }
  const maxStart = Math.max(totalLines - 1, 0);
  const startLine = Math.min(Math.max(range.startLine, 0), maxStart);
  const endLine = Math.min(Math.max(range.endLine, startLine + 1), totalLines);
  if (startLine === range.startLine && endLine === range.endLine) {
    return range;
  }
  return { ...range, endLine, startLine };
}

function clampRangesToTotal(
  ranges: TapestryRange[],
  totalLines: number
): { ranges: TapestryRange[]; changed: boolean } {
  let changed = false;
  const nextRanges = ranges.map((range) => {
    const nextRange = clampRangeToTotal(range, totalLines);
    if (nextRange !== range) {
      changed = true;
    }
    return nextRange;
  });
  return { changed, ranges: nextRanges };
}

export function clearUserOwnedTapestryRanges(
  prev: TapestryRangeMap,
  fileIds: readonly string[]
): TapestryRangeMap {
  let next: TapestryRangeMap | undefined;

  for (const fileId of fileIds) {
    const ranges = prev[fileId];
    if (!ranges) {
      continue;
    }

    const managedRanges = ranges.filter((range) => range.origin === 'search');
    if (managedRanges.length === ranges.length) {
      continue;
    }

    next ??= { ...prev };
    if (managedRanges.length === 0) {
      delete next[fileId];
    } else {
      next[fileId] = managedRanges;
    }
  }

  return next ?? prev;
}

/**
 * Applies a Tapestry-authored manual range proposal without trusting its
 * potentially stale snapshot of Search-managed ranges. Search remains the
 * sole owner of derived ranges; the interaction layer owns only manual ones.
 */
export function reconcileUserOwnedTapestryRanges(
  prev: TapestryRangeMap,
  fileId: string,
  proposedRanges: readonly TapestryRange[]
): TapestryRangeMap {
  const managedRanges = (prev[fileId] ?? []).filter((range) => range.origin === 'search');
  const manualRanges = proposedRanges.filter((range) => range.origin !== 'search');
  const nextRanges = [...managedRanges, ...manualRanges];
  const next = { ...prev };

  if (nextRanges.length === 0) {
    delete next[fileId];
    return next;
  }

  next[fileId] = nextRanges;
  return next;
}

export function syncTapestryRanges(args: {
  prev: TapestryRangeMap;
  bases: Map<string, ReturnType<typeof buildTapestryFileBase>>;
  totals: Map<string, number>;
}): { next: TapestryRangeMap; changed: boolean; totals: Map<string, number> } {
  const next: TapestryRangeMap = { ...args.prev };
  let changed = false;
  const nextTotals = new Map(args.totals);

  for (const [compositeKey, base] of args.bases) {
    // Before content loads, base.totalLines is an untrusted placeholder/estimate.
    // Clamping or stretching against it destroys ranges written by programmatic
    // writers (e.g. the workspace-search bridge squashed [1,8) -> [0,1) against a
    // ~1-line placeholder). Only a 'ready' base carries a trustworthy total.
    const isContentReady = base.contentStatus === 'ready';

    if (!next[compositeKey]) {
      // A rangeless selected file stays rangeless — no ranges means whole
      // file (the app's per-file rule), so there is nothing to seed here.
      if (isContentReady) {
        nextTotals.set(compositeKey, base.totalLines);
      }
      continue;
    }

    if (!isContentReady) {
      // Untrusted total: do not record a baseline or clamp. This protects
      // any range already written for this key until content lands.
      continue;
    }

    nextTotals.set(compositeKey, base.totalLines);

    const clamped = clampRangesToTotal(next[compositeKey], base.totalLines);
    if (clamped.changed) {
      next[compositeKey] = clamped.ranges;
      changed = true;
    }
  }

  for (const key of nextTotals.keys()) {
    if (!args.bases.has(key)) {
      nextTotals.delete(key);
    }
  }

  return { changed, next, totals: nextTotals };
}
