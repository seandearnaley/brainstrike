import type { TapestryRange } from '@brainstrike/file-explorer-ui';
import { TAPESTRY_COLOR_HEX, TAPESTRY_COLOR_NAMES } from '@brainstrike/types';
import type { SelectedChunk } from './chunk-selection-store';

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

/** Auto-assign palette, in TAPESTRY_COLOR_NAMES display order. */
const TAPESTRY_COLOR_PALETTE: readonly string[] = TAPESTRY_COLOR_NAMES.map(
  (name) => TAPESTRY_COLOR_HEX[name]
);

/** Deterministic color pick: index modulo the palette length. */
export function searchRangeColor(index: number): string {
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

function byStartThenEnd(a: TapestrySpan, b: TapestrySpan): number {
  return a.startLine - b.startLine || a.endLine - b.endLine;
}

/**
 * ONE-WAY derivation of the search-owned Tapestry ranges from the selected-chunk
 * SET (the source of truth). Selected chunks are converted to exclusive spans,
 * sorted, and merged into the MINIMAL covering set (overlapping OR adjacent spans
 * coalesce). Each covering span is stamped as an active, search-owned range
 * (`origin: 'search'`, `isActive: true`, `userModified: false`).
 *
 * Merging is safe here because it is OUTPUT-only: checkbox state is read from the
 * chunk set, never re-derived from these ranges, so a merge can no longer bleed
 * across sibling chunks (the defect the set-based model fixes). Empty input yields
 * no ranges — the preview panel's default then takes over for the file.
 */
export function deriveSearchRanges(
  chunks: readonly SelectedChunk[],
  makeId: () => string,
  colorForIndex: (index: number) => string
): TapestryRange[] {
  if (chunks.length === 0) {
    return [];
  }

  const spans = chunks
    .map((chunk) => toTapestrySpan({ endLine: chunk.endLine, startLine: chunk.startLine }))
    .sort(byStartThenEnd);

  const covering: TapestrySpan[] = [];
  for (const span of spans) {
    const last = covering.at(-1);
    // Overlapping OR adjacent (start <= current end) extends the covering span.
    if (last !== undefined && span.startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, span.endLine);
      continue;
    }
    covering.push({ endLine: span.endLine, startLine: span.startLine });
  }

  return covering.map((span, index) => ({
    color: colorForIndex(index),
    endLine: span.endLine,
    id: makeId(),
    isActive: true,
    origin: 'search',
    startLine: span.startLine,
    userModified: false,
  }));
}
