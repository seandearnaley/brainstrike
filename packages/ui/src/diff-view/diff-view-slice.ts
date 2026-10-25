import type { StructuredDiffHunk } from '@brainstrike/types';

/**
 * Slices an over-threshold `full` structured diff down to just its changed
 * regions, using the absolute hunk ranges git already computed in the main
 * process.
 *
 * Why this exists: `DiffView`'s render-side interactivity thresholds (see
 * `RENDER_SIDE_SIZE_THRESHOLD_BYTES` in `diff-view.tsx`) deliberately refuse
 * to hand a large document pair to `@codemirror/merge`, whose chunk
 * computation is O(n·d) and synchronous on the renderer main thread. Without
 * slicing, the only honest thing left to show is ONE side read-only — no
 * change visibility at all. But the engine also hands us
 * {@link StructuredFileDiff.hunks}: absolute `oldStart`/`oldLines`/
 * `newStart`/`newLines` ranges, already computed by git. Those tell us
 * exactly WHERE the changes are for free, so the renderer can cut both
 * documents down to those regions (plus context) and diff only that — real
 * change highlighting, real line numbers, and a diff whose cost is bounded
 * by the size of the changed regions rather than the size of the file.
 *
 * This module never diffs anything itself; it only slices. The caller still
 * re-checks the sliced result against the same interactivity thresholds
 * before mounting a `MergeView` (a file where nearly every line changed
 * slices to nearly itself), and falls back to the single-side read-only view
 * when it doesn't fit.
 */

/**
 * Unchanged lines kept on each side of a hunk. Six — double git's default
 * three — because this view has no "expand context" affordance: the margin
 * shown here is all the orientation a reader gets.
 */
const SLICE_CONTEXT_LINES = 6;

/**
 * Stand-in line for an elided unchanged region. Emitted IDENTICALLY on both
 * sides so `MergeView` reads it as unchanged context and the two slices stay
 * aligned — a per-side marker naming how many lines were skipped would
 * differ between the sides and render as a spurious change.
 */
const SLICE_GAP_MARKER = '⋯';

/**
 * {@link SlicedTextDiff} line-map sentinel: this document line is a
 * {@link SLICE_GAP_MARKER}, not a line of the file, and therefore has no
 * real line number. Zero is safe as the sentinel because git line numbers
 * are 1-based.
 */
const GAP_LINE = 0;

/** One contiguous region of both documents, in absolute 1-based file lines. */
interface SliceGroup {
  newFrom: number;
  newTo: number;
  oldFrom: number;
  oldTo: number;
}

/**
 * A sliced document pair plus, for each side, the absolute file line every
 * document line came from ({@link GAP_LINE} for gap markers). The maps are
 * what let the gutter show REAL line numbers over a sliced document — see
 * {@link formatSlicedLineNumber}.
 */
export interface SlicedTextDiff {
  readonly modified: string;
  /** `modifiedLineMap[i]` is the absolute new-side line of document line `i + 1`. */
  readonly modifiedLineMap: readonly number[];
  readonly original: string;
  /** `originalLineMap[i]` is the absolute old-side line of document line `i + 1`. */
  readonly originalLineMap: readonly number[];
}

/**
 * Flattens hunk ranges to a plain string.
 *
 * `DiffView`'s CodeMirror build effect keys its dependency array on SCALAR
 * values only, so that a caller re-rendering with a freshly-allocated
 * `source` literal carrying the same content does not tear down and rebuild
 * the editor (see the effect's dependency comment). `hunks` is an array — a
 * fresh identity on every such render — so it can never be a dependency
 * directly. Serializing it to a string makes it one: two renders with equal
 * hunk ranges produce an equal string, which compares equal by value.
 * {@link buildSlicedTextDiff} therefore takes the string and parses it back,
 * rather than taking the array.
 */
export function serializeHunkRanges(hunks: readonly StructuredDiffHunk[]): string {
  return hunks
    .map((hunk) => `${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}`)
    .join(';');
}

/** Reads `values[index]`, throwing when it is missing or not a non-negative integer. */
function requireCount(values: readonly number[], index: number, entry: string): number {
  const value = values[index];
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`DiffView: malformed serialized hunk range "${entry}".`);
  }
  return value;
}

/**
 * Inverse of {@link serializeHunkRanges}. Malformed input throws rather than
 * being skipped — this string is produced by our own serializer, so anything
 * else is a real bug and silently dropping a hunk would silently hide a
 * change.
 */
function parseHunkRanges(hunksKey: string): readonly StructuredDiffHunk[] {
  if (hunksKey.length === 0) {
    return [];
  }
  return hunksKey.split(';').map((entry) => {
    const values = entry.split(',').map(Number);
    if (values.length !== 4) {
      throw new Error(`DiffView: malformed serialized hunk range "${entry}".`);
    }
    return {
      newLines: requireCount(values, 3, entry),
      newStart: requireCount(values, 2, entry),
      oldLines: requireCount(values, 1, entry),
      oldStart: requireCount(values, 0, entry),
    };
  });
}

/**
 * A forward-only position in a document: `offset` is where line `line`
 * begins, or `-1` once the cursor has moved past the last line.
 *
 * Slices are emitted in ascending line order, so one forward pass per side
 * is enough — the document is scanned for line breaks at most once, and only
 * the lines actually emitted are allocated as strings. A `split('\n')` here
 * would instead allocate one string per line of the WHOLE file (tens of
 * thousands, for the multi-hundred-KiB documents this module exists to
 * serve) every time it runs, and `DiffView` runs it on every render.
 *
 * Line boundaries are `'\n'` only, not the CRLF-aware set: that counts
 * exactly what git counts, and leaves any `\r` attached so the sliced text
 * stays byte-faithful to the file.
 */
interface LineCursor {
  line: number;
  offset: number;
}

function createLineCursor(text: string): LineCursor {
  // An empty document has zero lines, not one empty line.
  return { line: 1, offset: text.length === 0 ? -1 : 0 };
}

/** Text of the line at the cursor. Only valid while `offset !== -1`. */
function readLine(text: string, cursor: LineCursor): string {
  const breakAt = text.indexOf('\n', cursor.offset);
  return breakAt === -1 ? text.slice(cursor.offset) : text.slice(cursor.offset, breakAt);
}

/**
 * Moves to the next line, exhausting the cursor when there is none. A single
 * trailing newline terminates the last line rather than starting an empty
 * one — the same line count git reports.
 */
function advanceLine(text: string, cursor: LineCursor): void {
  const breakAt = text.indexOf('\n', cursor.offset);
  if (breakAt === -1 || breakAt + 1 >= text.length) {
    cursor.offset = -1;
    return;
  }
  cursor.offset = breakAt + 1;
  cursor.line += 1;
}

/**
 * Expands each hunk by {@link SLICE_CONTEXT_LINES} on both sides and merges
 * groups whose ranges touch or overlap.
 *
 * The merge test is an OR across the two sides on purpose: if EITHER side's
 * expanded ranges run together, both sides must be emitted as one group, or
 * the old and new slices would be cut at different places and stop
 * corresponding to each other. A pure insertion (`oldLines === 0`) has no
 * old-side lines of its own, so its old anchor line is treated as a
 * single-line range — `oldStart` is the line the insertion follows, which is
 * real context worth showing.
 */
function buildSliceGroups(hunks: readonly StructuredDiffHunk[]): readonly SliceGroup[] {
  const groups: SliceGroup[] = [];
  for (const hunk of hunks) {
    const candidate: SliceGroup = {
      newFrom: hunk.newStart - SLICE_CONTEXT_LINES,
      newTo: hunk.newStart + Math.max(hunk.newLines, 1) - 1 + SLICE_CONTEXT_LINES,
      oldFrom: hunk.oldStart - SLICE_CONTEXT_LINES,
      oldTo: hunk.oldStart + Math.max(hunk.oldLines, 1) - 1 + SLICE_CONTEXT_LINES,
    };
    const previous = groups.at(-1);
    if (
      previous &&
      (candidate.oldFrom <= previous.oldTo + 1 || candidate.newFrom <= previous.newTo + 1)
    ) {
      previous.oldTo = Math.max(previous.oldTo, candidate.oldTo);
      previous.newTo = Math.max(previous.newTo, candidate.newTo);
      continue;
    }
    groups.push(candidate);
  }
  return groups;
}

/** Accumulator for one side's sliced document text and its absolute-line map. */
interface SlicedSide {
  /** Highest absolute file line emitted so far; 0 before the first group. */
  emittedThrough: number;
  readonly lineMap: number[];
  readonly lines: string[];
}

function createSlicedSide(): SlicedSide {
  return { emittedThrough: 0, lineMap: [], lines: [] };
}

function appendGap(side: SlicedSide): void {
  side.lines.push(SLICE_GAP_MARKER);
  side.lineMap.push(GAP_LINE);
}

/**
 * Emits file lines `from`..`to` (1-based, inclusive), skipping ahead as
 * needed and stopping early if the document ends first — which is also how
 * `to` gets clamped to the document's real length, with no separate line
 * count to compute.
 */
function appendRange(
  side: SlicedSide,
  text: string,
  cursor: LineCursor,
  from: number,
  to: number
): void {
  while (cursor.offset !== -1 && cursor.line < from) {
    advanceLine(text, cursor);
  }
  while (cursor.offset !== -1 && cursor.line <= to) {
    side.lines.push(readLine(text, cursor));
    side.lineMap.push(cursor.line);
    side.emittedThrough = cursor.line;
    advanceLine(text, cursor);
  }
}

/**
 * Cuts `original`/`modified` down to the regions named by `hunksKey`
 * (serialized by {@link serializeHunkRanges}), plus context.
 *
 * Returns `null` when there are no hunk ranges to slice around. That is a
 * real, documented state — `StructuredFileDiff.hunks` is populated only when
 * a git unified diff was actually computed, so it is empty for binary
 * content, for untracked whole-file additions, and for every journal-sourced
 * diff. With no ranges there is genuinely no way to locate the changes
 * without diffing the whole document, which is exactly what the render-side
 * thresholds forbid; the caller must say so plainly rather than invent a
 * region.
 */
export function buildSlicedTextDiff(
  original: string,
  modified: string,
  hunksKey: string
): SlicedTextDiff | null {
  const groups = buildSliceGroups(parseHunkRanges(hunksKey));
  if (groups.length === 0) {
    return null;
  }

  const originalCursor = createLineCursor(original);
  const modifiedCursor = createLineCursor(modified);
  const originalSide = createSlicedSide();
  const modifiedSide = createSlicedSide();

  for (const group of groups) {
    const oldFrom = Math.max(1, group.oldFrom);
    const newFrom = Math.max(1, group.newFrom);
    // A gap on EITHER side marks BOTH, so the two documents always elide at
    // the same group boundaries and their regions keep corresponding. (Equal
    // total line counts is NOT implied and is not needed — a hunk can add or
    // remove lines, and MergeView aligns the sides by diffing them, not by
    // index; what matters is that neither side silently swallows a region
    // the other still shows.)
    if (oldFrom > originalSide.emittedThrough + 1 || newFrom > modifiedSide.emittedThrough + 1) {
      appendGap(originalSide);
      appendGap(modifiedSide);
    }
    appendRange(originalSide, original, originalCursor, oldFrom, group.oldTo);
    appendRange(modifiedSide, modified, modifiedCursor, newFrom, group.newTo);
  }

  // An unexhausted cursor means the document continues past the last emitted
  // line — the trailing elision, detected without counting total lines.
  if (originalCursor.offset !== -1 || modifiedCursor.offset !== -1) {
    appendGap(originalSide);
    appendGap(modifiedSide);
  }

  return {
    modified: modifiedSide.lines.join('\n'),
    modifiedLineMap: modifiedSide.lineMap,
    original: originalSide.lines.join('\n'),
    originalLineMap: originalSide.lineMap,
  };
}

/**
 * Builds the `formatNumber` callback for a sliced document's gutter: line
 * `lineNumber` (1-based) reports the absolute file line it came from, or
 * {@link SLICE_GAP_MARKER} for a gap line, which has no file line to name
 * and must never be given a fabricated one.
 *
 * CodeMirror also calls `formatNumber` with a synthetic line number PAST the
 * end of the document (`9`, `99`, `999`, … — see `maxLineNumber` in
 * `@codemirror/view`) to render the gutter's invisible width spacer. That is
 * a sizing probe, not a line, so it can't be treated as an out-of-range bug;
 * it gets the widest label this gutter will actually render, precomputed
 * once here, which is exactly the width the gutter needs to reserve.
 */
export function createSlicedLineNumberFormatter(
  lineMap: readonly number[]
): (lineNumber: number) => string {
  const spacerLabel = lineMap.reduce(
    (widest, absolute) => {
      const label = absolute === GAP_LINE ? SLICE_GAP_MARKER : String(absolute);
      return label.length > widest.length ? label : widest;
    },
    // Fallback width for an empty map (an empty document has no lines and so
    // no real label to measure), matching the vanilla gutter's own minimum.
    '0'
  );

  return (lineNumber) => {
    const absolute = lineMap[lineNumber - 1];
    if (absolute === undefined) {
      return spacerLabel;
    }
    return absolute === GAP_LINE ? SLICE_GAP_MARKER : String(absolute);
  };
}
