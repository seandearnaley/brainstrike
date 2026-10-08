const GUTTER_PREFIX_PATTERN = /^(\d+): /;
const MINIMUM_MATCHING_LINES = 3;

/**
 * Detect pasted `readWorkspaceFile` display text conservatively (PR #2352
 * review superseded the original 80%-majority + strict-`+1` design below).
 *
 * Refuses iff:
 * 1. At least three lines match the exact `N: ` gutter shape.
 * 2. Their captured numbers form a monotonic NON-DECREASING run (adjacent
 *    equal values are tolerated, never a decrease) with a TIGHT SPAN
 *    (`max - min < 2 * count`). Tolerating an exact adjacent repeat matters
 *    because `renderReadWorkspaceFilePage` re-emits the SAME line number as
 *    the prefix on both halves of a line split across a page boundary
 *    (`nextPosition: { column, line }` in read-workspace-file-tool.ts), so a
 *    verbatim paste of two continuation pages repeats that boundary number.
 *    The tight-span bound is what actually does the discriminating work: it
 *    tolerates a single deleted line (e.g. `10,11,13,14,15`, span 5 over 5
 *    matches) or a repeated boundary number, while still rejecting two
 *    unrelated reads concatenated together (e.g. `40,41,100,101`, span 61
 *    over 4 matches) and non-sequential content that merely starts with
 *    digits (`12,45,90` or `10,30,60`).
 * 3. The run's first (and, being non-decreasing, smallest) number is greater
 *    than 1.
 *
 * KNOWN COVERAGE BOUNDARY — deliberate, not an oversight: a page-1 paste
 * (numbers starting at 1) is NEVER refused, even a verbatim gutter dump like
 * `1: a\n2: b\n3: c`. Legitimate sequential numeric-key content — a YAML
 * mapping (`1: January\n2: February\n3: March`), a numbered config list, a
 * 1-based enumeration — is textually IDENTICAL to a page-1 gutter paste; no
 * signal in the text distinguishes them, since `readWorkspaceFile` defaults
 * to starting at line 1. Blocking that legitimate write is strictly worse
 * than missing this one class of accidental paste: a false refusal makes an
 * ordinary numbered write permanently impossible through these tools, while
 * a missed page-1 paste still gets caught by the model's own read-verify
 * cycle after the corrupted write lands. Only a read that started past line
 * 1 (an explicit `startLine`, or a continuation cursor) produces gutter
 * numbers starting above 1, so only THOSE pastes are guarded.
 */
export function looksLikeReadWorkspaceFileGutterOutput(candidate: string): boolean {
  const nonEmptyLines = candidate.split('\n').filter((line) => line.length > 0);
  if (nonEmptyLines.length < MINIMUM_MATCHING_LINES) {
    return false;
  }

  const matchingLineNumbers: number[] = [];
  for (const line of nonEmptyLines) {
    const match = GUTTER_PREFIX_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const lineNumber = Number(match[1]);
    // An out-of-range number disqualifies only THIS line, not the whole
    // payload — `continue` keeps the decision local so a single absurd
    // trailing line (e.g. an attacker appending
    // `99999999999999999999: x`) cannot disable the guard for an otherwise
    // perfect gutter block (PR #2352 review).
    if (!Number.isSafeInteger(lineNumber)) {
      continue;
    }
    matchingLineNumbers.push(lineNumber);
  }

  if (matchingLineNumbers.length < MINIMUM_MATCHING_LINES) {
    return false;
  }

  const first = matchingLineNumbers[0];
  if (first === undefined || first <= 1) {
    return false;
  }

  let min = first;
  let max = first;
  for (let index = 1; index < matchingLineNumbers.length; index += 1) {
    const previous = matchingLineNumbers[index - 1];
    const current = matchingLineNumbers[index];
    if (previous === undefined || current === undefined || current < previous) {
      return false;
    }
    min = current < min ? current : min;
    max = current > max ? current : max;
  }

  return max - min < 2 * matchingLineNumbers.length;
}
