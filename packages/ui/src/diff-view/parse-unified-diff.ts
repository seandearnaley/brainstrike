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

/**
 * How a single in-hunk line maps onto the reconstructed sides.
 * - `addition` → modified only; `deletion` → original only; `context` → both.
 * - `skip` → metadata / truncation marker / trailing artifact (dropped).
 * - `end-hunk` → a file-header line that ends the current hunk.
 */
type HunkLineKind = 'addition' | 'deletion' | 'context' | 'skip' | 'end-hunk';

/** Classify one line that occurs INSIDE a hunk into a {@link HunkLineKind}. */
function classifyHunkLine(
  line: string,
  isLastLine: boolean
): { kind: HunkLineKind; content: string } {
  // INSIDE a hunk, a real content line always carries a 1-char prefix
  // (`+` / `-` / ` `). Detect that FIRST so a changed line whose own text starts
  // with `-- ` / `++ ` (raw `--- heading` / `+++ heading`) is parsed as a
  // deletion/addition, NOT mistaken for a `--- ` / `+++ ` file header.
  const marker = line[0];
  if (marker === '+') {
    return { content: line.slice(1), kind: 'addition' };
  }
  if (marker === '-') {
    return { content: line.slice(1), kind: 'deletion' };
  }
  if (marker === ' ') {
    return { content: line.slice(1), kind: 'context' };
  }
  // `\ No newline at end of file` is metadata; the git-service's literal
  // `…(output truncated)` marker is not content (the badge already signals it).
  if (line.startsWith('\\') || line.startsWith('…')) {
    return { content: '', kind: 'skip' };
  }
  if (isDiffHeaderLine(line)) {
    return { content: '', kind: 'end-hunk' };
  }
  // An empty line: ONLY the final element is the trailing-newline artifact of
  // `split('\n')` and is dropped. A non-final empty line is a genuine blank
  // context row some producers emit unprefixed — keep it so sides stay aligned.
  if (line.length === 0) {
    return isLastLine ? { content: '', kind: 'skip' } : { content: '', kind: 'context' };
  }
  // Any other unprefixed, non-header line is unexpected; treat as shared context
  // rather than silently dropping it (keeps alignment).
  return { content: line, kind: 'context' };
}

export function parseUnifiedDiff(unifiedDiff: string): ParsedUnifiedDiff {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;
  let hasHunks = false;

  const rawLines = unifiedDiff.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = (rawLines[index] ?? '').replace(/\r$/, '');

    if (line.startsWith('@@')) {
      inHunk = true;
      hasHunks = true;
      continue;
    }
    if (!inHunk) {
      // Skip the `diff --git` / `index` / `---` / `+++` preamble.
      continue;
    }

    const { kind, content } = classifyHunkLine(line, index === rawLines.length - 1);
    if (kind === 'end-hunk') {
      inHunk = false;
    } else if (kind === 'addition') {
      modifiedLines.push(content);
    } else if (kind === 'deletion') {
      originalLines.push(content);
    } else if (kind === 'context') {
      originalLines.push(content);
      modifiedLines.push(content);
    }
    // 'skip' → nothing.
  }

  return {
    hasHunks,
    modified: modifiedLines.join('\n'),
    original: originalLines.join('\n'),
  };
}
