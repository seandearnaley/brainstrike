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
  // created before the userModified flag existed.
  return firstRange.startLine === 0 && !firstRange.userModified;
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
    const previousTotal = nextTotals.get(compositeKey);
    nextTotals.set(compositeKey, base.totalLines);

    if (!next[compositeKey]) {
      next[compositeKey] = createDefaultTapestryRanges(compositeKey, base.totalLines);
      changed = true;
      continue;
    }

    const ranges = next[compositeKey];
    if (
      previousTotal !== undefined &&
      previousTotal !== base.totalLines &&
      shouldStretchDefaultRange(ranges)
    ) {
      const [firstRange] = ranges;
      if (firstRange) {
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
