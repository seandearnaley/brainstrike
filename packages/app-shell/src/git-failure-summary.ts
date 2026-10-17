/** Longest git failure text compact UI shows; the full text stays in the log. */
const MAX_SUMMARY_LENGTH = 160;

/**
 * A bounded, single-line summary of a git failure for compact UI (chips, menu
 * rows). A failed command's stderr can run to many lines; its first non-empty
 * line is the actionable one ("fatal: …"). Callers log the full text where they
 * read it, so nothing is lost, only kept out of titles and accessible names.
 */
export function summarizeGitFailure(error: string): string {
  const firstLine =
    error
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'unknown error';
  return firstLine.length > MAX_SUMMARY_LENGTH
    ? `${firstLine.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : firstLine;
}
