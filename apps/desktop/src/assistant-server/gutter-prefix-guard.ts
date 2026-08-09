const GUTTER_PREFIX_PATTERN = /^(\d+): /;
const MINIMUM_MATCHING_LINES = 3;

/**
 * Detect pasted `readWorkspaceFile` display text conservatively. Real content
 * with coincidental numeric prefixes must remain writable, so refusal requires
 * an 80% majority, at least three matches, and one strict sequential run.
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
    if (!Number.isSafeInteger(lineNumber)) {
      return false;
    }
    matchingLineNumbers.push(lineNumber);
  }

  if (
    matchingLineNumbers.length < MINIMUM_MATCHING_LINES ||
    matchingLineNumbers.length * 5 < nonEmptyLines.length * 4
  ) {
    return false;
  }

  for (let index = 1; index < matchingLineNumbers.length; index += 1) {
    const previousLineNumber = matchingLineNumbers[index - 1];
    const lineNumber = matchingLineNumbers[index];
    if (
      previousLineNumber === undefined ||
      lineNumber === undefined ||
      lineNumber !== previousLineNumber + 1
    ) {
      return false;
    }
  }
  return true;
}
