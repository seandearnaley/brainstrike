import type { TapestryRange } from '@brainstrike/file-explorer-ui';
import { TAPESTRY_COLOR_HEX, TAPESTRY_COLOR_NAMES } from '@brainstrike/types';

/** Chunk line bounds are 1-based and INCLUSIVE: [startLine..endLine]. */
export interface ChunkBounds {
  endLine: number;
  startLine: number;
}

/** Tapestry span is [startLine, endLine) — endLine EXCLUSIVE. */
export interface TapestrySpan {
  endLine: number;
  startLine: number;
}

export type CoverageState = 'checked' | 'unchecked' | 'indeterminate';

/** Auto-assign palette, in TAPESTRY_COLOR_NAMES display order. */
const TAPESTRY_COLOR_PALETTE: readonly string[] = TAPESTRY_COLOR_NAMES.map(
  (name) => TAPESTRY_COLOR_HEX[name]
);

/** Deterministic color pick: index modulo the palette length. */
function colorForIndex(index: number): string {
  const color = TAPESTRY_COLOR_PALETTE[index % TAPESTRY_COLOR_PALETTE.length];
  if (color === undefined) {
    // Unreachable: the palette is a non-empty compile-time constant.
    throw new Error('Tapestry color palette is empty');
  }
  return color;
}

/**
 * Convert an INCLUSIVE 1-based chunk [start..end] into an EXCLUSIVE tapestry
 * span [start, end+1). e.g. {10,14} -> {10,15}.
 */
export function toTapestrySpan(chunk: ChunkBounds): TapestrySpan {
  return { endLine: chunk.endLine + 1, startLine: chunk.startLine };
}

/**
 * A range that search toggles may coalesce/trim: active AND not user-modified.
 * userModified ranges are hand-curated Tapestry state and MUST survive verbatim.
 */
function isSearchManaged(range: TapestryRange): boolean {
  return range.isActive && !range.userModified;
}

interface MergeCandidate {
  endLine: number;
  /** The untouched original when this candidate is exactly one existing range. */
  original: TapestryRange | null;
  startLine: number;
}

function byStartThenEnd(a: TapestrySpan, b: TapestrySpan): number {
  return a.startLine - b.startLine || a.endLine - b.endLine;
}

/**
 * Insert the chunk's span as a new active range and coalesce overlapping/ADJACENT
 * active non-userModified ranges. userModified and inactive ranges are preserved
 * verbatim (never merged into, mutated, or absorbed) — the new range may coexist
 * with or overlap them.
 */
export function addChunkRange(
  existing: readonly TapestryRange[],
  chunk: ChunkBounds,
  makeId: () => string
): TapestryRange[] {
  const span = toTapestrySpan(chunk);
  const preserved: TapestryRange[] = [];
  const candidates: MergeCandidate[] = [];

  for (const range of existing) {
    if (isSearchManaged(range)) {
      candidates.push({ endLine: range.endLine, original: range, startLine: range.startLine });
    } else {
      preserved.push(range);
    }
  }
  candidates.push({ endLine: span.endLine, original: null, startLine: span.startLine });
  candidates.sort(byStartThenEnd);

  const colorIndex = existing.length;
  const merged: TapestryRange[] = [];
  let group: MergeCandidate[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  const flushGroup = (): void => {
    const first = group[0];
    if (first === undefined) {
      return;
    }
    const untouchedOriginal = group.length === 1 && first.original !== null ? first.original : null;
    if (untouchedOriginal) {
      merged.push(untouchedOriginal);
    } else {
      merged.push({
        color: colorForIndex(colorIndex),
        endLine: groupEnd,
        id: makeId(),
        isActive: true,
        startLine: first.startLine,
      });
    }
    group = [];
  };

  for (const candidate of candidates) {
    // Overlapping OR adjacent (start <= current group end) joins the group.
    if (group.length > 0 && candidate.startLine > groupEnd) {
      flushGroup();
    }
    group.push(candidate);
    groupEnd = group.length === 1 ? candidate.endLine : Math.max(groupEnd, candidate.endLine);
  }
  flushGroup();

  return [...merged, ...preserved].sort(byStartThenEnd);
}

/**
 * Within the chunk's span, remove fully-covered non-userModified active ranges and
 * TRIM wider ones to the parts outside the span (split when both sides remain).
 * userModified and inactive ranges are left untouched.
 */
export function removeChunkRange(
  existing: readonly TapestryRange[],
  chunk: ChunkBounds
): TapestryRange[] {
  const span = toTapestrySpan(chunk);
  const result: TapestryRange[] = [];

  for (const range of existing) {
    if (!isSearchManaged(range)) {
      result.push(range);
      continue;
    }
    const overlaps = range.startLine < span.endLine && range.endLine > span.startLine;
    if (!overlaps) {
      result.push(range);
      continue;
    }
    // Left remainder [range.start, span.start).
    if (range.startLine < span.startLine) {
      result.push({ ...range, endLine: span.startLine });
    }
    // Right remainder [span.end, range.end) — derived id keeps it unique when split.
    if (range.endLine > span.endLine) {
      result.push({ ...range, id: `${range.id}:${span.endLine}`, startLine: span.endLine });
    }
    // Fully covered: dropped.
  }

  return result;
}

/**
 * Coverage of a chunk by the union of ACTIVE tapestry ranges for its file.
 * File unselected -> 'unchecked'. File selected with NO ranges for the key
 * (undefined or empty) -> 'checked' (whole-file semantics).
 */
export function chunkCoverage(
  fileSelected: boolean,
  ranges: readonly TapestryRange[] | undefined,
  chunk: ChunkBounds
): CoverageState {
  if (!fileSelected) {
    return 'unchecked';
  }
  if (ranges === undefined || ranges.length === 0) {
    return 'checked';
  }

  const span = toTapestrySpan(chunk);
  const clipped: TapestrySpan[] = [];
  for (const range of ranges) {
    if (!range.isActive) {
      continue;
    }
    const startLine = Math.max(range.startLine, span.startLine);
    const endLine = Math.min(range.endLine, span.endLine);
    if (startLine < endLine) {
      clipped.push({ endLine, startLine });
    }
  }

  if (clipped.length === 0) {
    return 'unchecked';
  }

  clipped.sort(byStartThenEnd);
  let cursor = span.startLine;
  for (const interval of clipped) {
    if (interval.startLine > cursor) {
      return 'indeterminate';
    }
    cursor = Math.max(cursor, interval.endLine);
  }
  return cursor >= span.endLine ? 'checked' : 'indeterminate';
}

/** Roll a file's checkbox state up from its chunk child states. */
export function fileCoverage(
  fileSelected: boolean,
  childStates: readonly CoverageState[]
): CoverageState {
  if (!fileSelected) {
    return 'unchecked';
  }
  if (childStates.length === 0) {
    return 'checked';
  }
  return childStates.every((state) => state === 'checked') ? 'checked' : 'indeterminate';
}
