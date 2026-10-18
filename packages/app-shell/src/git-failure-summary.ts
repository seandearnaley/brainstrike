/** Longest git failure text compact UI shows; the full text stays in the log. */
const MAX_SUMMARY_LENGTH = 160;

/**
 * Lines that state a git failure, most actionable first. A rejected push opens
 * with "To <remote>" and closes with the generic "error: failed to push some
 * refs"; the cause is the remote's own `remote: error:` line (a hook or branch
 * rule) or git's `! [rejected] … (reason)` line.
 */
const FAILURE_LINE_RANKING: readonly RegExp[] = [
  /^remote:\s*(?:fatal|error):/iu,
  /^!\s*\[(?:remote )?rejected\]/iu,
  /^(?:fatal|error):/iu,
];

/**
 * A bounded, single-line summary of a git failure for compact UI (chips, menu
 * rows, toasts): the most actionable failure line (see
 * {@link FAILURE_LINE_RANKING}), else the first non-empty line, with git's
 * column padding collapsed. Callers log or disclose the full text, so nothing
 * is lost, only kept out of the headline.
 */
export function summarizeGitFailure(error: string): string {
  const lines = error
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter((line) => line.length > 0);
  const line =
    FAILURE_LINE_RANKING.map((pattern) => lines.find((candidate) => pattern.test(candidate))).find(
      (candidate) => candidate !== undefined
    ) ?? lines[0];
  if (!line) {
    return 'unknown error';
  }
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : line;
}
