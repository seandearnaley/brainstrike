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
