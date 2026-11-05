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
 * read. An unexpected empty field here throws instead.
 */

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
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`git numstat -z returned a non-numeric count "${raw}" in record "${record}"`);
  }
  return Number(raw);
}

// `-z` paths are emitted verbatim (no quoting/escaping), so a path may
// legally contain a tab. Only the first two tabs are field separators; the
// third capture group is everything after the second tab, tabs included.
const NUMSTAT_RECORD_PATTERN = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/u;

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
