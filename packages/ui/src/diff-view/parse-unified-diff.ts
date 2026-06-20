/**
 * Reconstruct the "before" (original) and "after" (modified) file contents from
 * a single-file unified diff (the `git diff` text shape returned by the desktop
 * `window.git.diff` bridge as `GitDiff.unifiedDiff`).
 *
 * The desktop git bridge returns a unified diff STRING, not the two full file
 * versions. {@link DiffView} is content-based (it takes `original` + `modified`)
 * so it can be reused by the future edit-approval flow, which already has both
 * sides. This adapter bridges the gap: it walks the hunks and replays the `-`
 * (deletion), `+` (addition) and ` ` (context) lines into two reconstructed
 * documents.
 *
 * This is a faithful reconstruction of the CHANGED region plus the surrounding
 * context lines git chose to include — it is NOT the whole file (git omits
 * unchanged regions outside the hunk context). That is exactly what a reviewer
 * wants to see, and it makes the side-by-side and inline views line up.
 *
 * No-silent-fallbacks: a diff that contains no recognizable hunk (`@@`) yields
 * two empty strings, which the caller renders as an explicit "no textual
 * changes" / binary-or-empty state rather than a crash.
 */

export interface ParsedUnifiedDiff {
  /** True when at least one `@@` hunk header was found and parsed. */
  readonly hasHunks: boolean;
  /** Reconstructed "after" content (additions + context). */
  readonly modified: string;
  /** Reconstructed "before" content (deletions + context). */
  readonly original: string;
}

/** True for the metadata/header lines that precede the first hunk or annotate it. */
function isDiffHeaderLine(line: string): boolean {
  return (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('similarity ') ||
    line.startsWith('dissimilarity ') ||
    line.startsWith('Binary files ') ||
    line.startsWith('GIT binary patch')
  );
}

export function parseUnifiedDiff(unifiedDiff: string): ParsedUnifiedDiff {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;
  let hasHunks = false;

  for (const rawLine of unifiedDiff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.startsWith('@@')) {
      inHunk = true;
      hasHunks = true;
      continue;
    }

    if (!inHunk) {
      // Skip the `diff --git` / `index` / `---` / `+++` preamble.
      continue;
    }

    if (isDiffHeaderLine(line)) {
      // A new file's preamble inside a multi-file diff — leave hunk mode until
      // the next `@@`.
      inHunk = false;
      continue;
    }

    // `\ No newline at end of file` is metadata, not content.
    if (line.startsWith('\\')) {
      continue;
    }

    // A zero-length line is the artifact of the diff's trailing newline (the
    // final element of `split('\n')`), never a real hunk line: git always emits
    // context/added/removed lines with a 1-char ` `/`+`/`-` prefix. Skipping it
    // prevents a spurious trailing blank line on both reconstructed sides.
    if (line.length === 0) {
      continue;
    }

    const marker = line[0];
    const content = line.slice(1);
    if (marker === '+') {
      modifiedLines.push(content);
    } else if (marker === '-') {
      originalLines.push(content);
    } else {
      // Context line (leading space) or an empty line within the hunk: present
      // on both sides.
      originalLines.push(content);
      modifiedLines.push(content);
    }
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
    hasHunks,
  };
}
