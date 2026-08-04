/**
 * Pure structured-diff parsers for the Changeset Diff Viewer engine
 * (spec: docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md).
 *
 * Mirrors `git-repository-parsers.ts`'s posture: pure functions over git's
 * stdout, throw on unparseable input, never silently skip or coerce.
 *
 * `parseNumstatZ`'s rename-triple decode is intentionally NOT preceded by an
 * empty-field filter — the changeset-discovery spike's `parseNumstat` used
 * `.filter(Boolean)` before positional indexing, which silently drops an
 * unexpected empty field and shifts every subsequent record's positional
 * read (spikes/changeset-discovery/RECOMMENDATION.md, Task 4 "known spike
 * shortcuts"). An unexpected empty field here throws instead.
 */

import type { StructuredDiffHunk } from '@brainstrike/types';

/** One record from `git diff --numstat -z [--find-renames]`. */
export interface NumstatEntry {
  /** Line additions, or null for a binary file ("-"). */
  readonly additions: number | null;
  readonly deletions: number | null;
  /** Previous path for a rename record, null otherwise. */
  readonly oldPath: string | null;
  readonly path: string;
}

function parseNumstatCount(raw: string, record: string): number | null {
  if (raw === '-') {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`git numstat -z returned a non-numeric count "${raw}" in record "${record}"`);
  }
  return Number(raw);
}

// `-z` paths are emitted verbatim (no quoting/escaping), so a path may
// legally contain a tab. Only the first two tabs are field separators; the
// third capture group is everything after the second tab, tabs included.
const NUMSTAT_RECORD_PATTERN = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/;

/**
 * Parse `git diff --numstat -z [--find-renames]` output.
 *
 * Non-rename records are one NUL-terminated field: `adds\tdels\tpath`.
 * A rename record is a triple: `adds\tdels\t` (trailing tab, empty path)
 * NUL `oldPath` NUL `newPath` — decoded strictly by position, confirmed
 * against real `git diff --cached --numstat -z --find-renames` output.
 */
export function parseNumstatZ(output: string): readonly NumstatEntry[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }

  const entries: NumstatEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index] ?? '';
    const match = NUMSTAT_RECORD_PATTERN.exec(record);
    if (!match) {
      throw new Error(`git numstat -z returned a malformed record "${record}"`);
    }
    const [, addsRaw = '', delsRaw = '', inlinePath = ''] = match;
    const additions = parseNumstatCount(addsRaw, record);
    const deletions = parseNumstatCount(delsRaw, record);

    if (inlinePath !== '') {
      entries.push({ additions, deletions, oldPath: null, path: inlinePath });
      index += 1;
      continue;
    }

    // Rename triple: this field carried no path (trailing tab), so the old
    // and new paths are the next two NUL-delimited fields, positionally.
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    if (!(oldPath && newPath)) {
      throw new Error(`git numstat -z returned a malformed rename record "${record}"`);
    }
    entries.push({ additions, deletions, oldPath, path: newPath });
    index += 3;
  }

  return entries;
}

const HUNK_HEADER_CANDIDATE = /^@@ -/;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER_PATTERN = /^diff --git /;
const TRUNCATION_MARKER = '…(output truncated)';

/**
 * Extract `@@ -a[,b] +c[,d] @@` hunk headers from a unified diff into
 * absolute line ranges (omitted count defaults to 1). Non-header lines are
 * ignored. A line matched as a hunk-header candidate (`^@@ -`) but not fully
 * parseable throws — UNLESS it is immediately followed by the literal
 * `…(output truncated)` boundOutput marker line, in which case the diff was
 * cut mid-header (not malformed) and the incomplete header is skipped
 * without contributing a hunk. Every other malformed header still throws.
 *
 * Precondition: `unifiedDiff` must be scoped to a single file's diff output
 * (at most one `diff --git ` header) — a second `diff --git ` line throws,
 * since hunks from different files would otherwise be flattened into one
 * indistinguishable array.
 */
export function parseHunkHeaders(unifiedDiff: string): readonly StructuredDiffHunk[] {
  const lines = unifiedDiff.split('\n');
  const hunks: StructuredDiffHunk[] = [];
  let sawFileHeader = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (FILE_HEADER_PATTERN.test(line)) {
      if (sawFileHeader) {
        throw new Error(
          `parseHunkHeaders expects a single-file diff but encountered a second "diff --git " header: "${line}"`
        );
      }
      sawFileHeader = true;
      continue;
    }

    if (!HUNK_HEADER_CANDIDATE.test(line)) {
      continue;
    }
    const match = HUNK_HEADER_PATTERN.exec(line);
    if (!match) {
      if (lines[i + 1] === TRUNCATION_MARKER) {
        continue;
      }
      throw new Error(`git diff returned a malformed hunk header "${line}"`);
    }
    const [, oldStartRaw, oldLinesRaw, newStartRaw, newLinesRaw] = match;
    hunks.push({
      newLines: newLinesRaw === undefined ? 1 : Number(newLinesRaw),
      newStart: Number(newStartRaw),
      oldLines: oldLinesRaw === undefined ? 1 : Number(oldLinesRaw),
      oldStart: Number(oldStartRaw),
    });
  }
  return hunks;
}

/**
 * Count lines the way `git`'s line counts behave: newline-terminated text
 * counts the terminated lines, not `split('\n').length` (which double-counts
 * the trailing empty segment after a final newline — the spike's untracked
 * `additions` off-by-one, RECOMMENDATION.md Task 4).
 */
export function countLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split('\n').length;
}
