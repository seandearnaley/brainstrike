/**
 * Pure utility functions for synchronizing tapestry range state.
 *
 * Extracted from preview-panel.tsx to reduce component module size
 * and improve testability of range clamping/sync logic.
 */

import type { buildTapestryFileBase } from '../tapestry/tapestry-adapter';
import type { TapestryRange } from '../tapestry/types';
import { createRangeId, getStableColorForKey } from '../tapestry/utils';
import type { TapestryRangeMap } from './context-selected-token-summary';

export function createDefaultTapestryRanges(
  compositeKey: string,
  totalLines: number
): TapestryRange[] {
  return [
    {
      color: getStableColorForKey(compositeKey),
      endLine: totalLines,
      id: createRangeId(),
      isActive: true,
      startLine: 0,
      userModified: false,
    },
  ];
}

function shouldStretchDefaultRange(ranges: TapestryRange[]): ranges is [TapestryRange] {
  if (ranges.length !== 1) {
    return false;
  }
  const firstRange = ranges[0];
  if (!firstRange) {
    return false;
  }
  // Use the userModified flag rather than position heuristics. A range that
  // was never manually adjusted should auto-stretch when content loads and
  // totalLines changes. The startLine===0 guard is a safety net for ranges
  // created before the userModified flag existed. search-origin ranges are
  // owned by the workspace-search bridge and are never the auto-created default,
  // so they must never be stretched even when they sit at startLine 0.
  return firstRange.startLine === 0 && !firstRange.userModified && firstRange.origin !== 'search';
}

function stretchDefaultRange(range: TapestryRange, totalLines: number): TapestryRange[] {
  return [{ ...range, endLine: totalLines }];
}

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
      // Default creation for a rangeless file stays even before content is ready
      // so a newly selected file gets its full-file default immediately.
      next[compositeKey] = createDefaultTapestryRanges(compositeKey, base.totalLines);
      changed = true;
      if (isContentReady) {
        nextTotals.set(compositeKey, base.totalLines);
      }
      continue;
    }

    if (!isContentReady) {
      // Untrusted total: do not record a baseline, clamp, or stretch. This
      // protects any range already written for this key until content lands.
      continue;
    }

    const previousTotal = nextTotals.get(compositeKey);
    nextTotals.set(compositeKey, base.totalLines);

    const ranges = next[compositeKey];
    if (previousTotal !== base.totalLines && shouldStretchDefaultRange(ranges)) {
      const [firstRange] = ranges;
      if (firstRange.endLine !== base.totalLines) {
        next[compositeKey] = stretchDefaultRange(firstRange, base.totalLines);
        changed = true;
      }
    }

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
