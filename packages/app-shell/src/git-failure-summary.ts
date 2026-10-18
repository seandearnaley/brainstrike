/** Longest git failure text compact UI shows; the full text stays in the log. */
const MAX_SUMMARY_LENGTH = 160;

/** Git's own failure lines; progress and context lines ("To <remote>") precede them. */
const GIT_FAILURE_LINE = /^(?:fatal|error):/iu;

/**
 * A bounded, single-line summary of a git failure for compact UI (chips, menu
 * rows, toasts). A failed command's stderr can run to many lines, and the
 * actionable one is git's first `fatal:`/`error:` line: a rejected push opens
 * with "To <remote>". Without one, the first non-empty line stands. Callers log
 * or disclose the full text, so nothing is lost, only kept out of the headline.
 */
export function summarizeGitFailure(error: string): string {
  const lines = error
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.find((candidate) => GIT_FAILURE_LINE.test(candidate)) ?? lines[0];
  if (!line) {
    return 'unknown error';
  }
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : line;
}
