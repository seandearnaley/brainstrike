/**
 * Surgical single-block string replacement with a fuzzy-match cascade.
 *
 * This is the PURE (no-IO) matching engine behind the desktop
 * `brainstrike.stringReplaceWorkspaceFile` tool. The caller reads the file,
 * passes its content here, and writes back the returned `newContent`.
 *
 * The fuzzy-match cascade is ported VERBATIM (algorithm-for-algorithm) from the
 * proven mastra-code editor (`src/tools/file-editor.ts` `strReplace`):
 *   1. exact substring match,
 *   2. whitespace-normalized match,
 *   3. char-level "no varying chars" prefix walk + per-line Levenshtein-fuzzy
 *      match (with the single-line in-line and delete-line variants).
 *
 * The ONE deliberate divergence from mastra-code: where the reference RETURNS a
 * human-readable failure string (a silent no-op as far as the file is
 * concerned), this engine THROWS a typed {@link StringReplaceError}. Per the
 * project's no-silent-fallbacks rule, an ambiguous or low-confidence match must
 * never be applied — a wrong-location edit silently corrupts code. The two
 * critical safety throws mirror mastra-code's refusal branches exactly:
 *   - SINGLE-LINE AMBIGUITY GUARD: a single-line `oldStr` matching multiple
 *     lines refuses (reason 'ambiguous') and asks for surrounding context.
 *   - NO sufficiently close match refuses (reason 'not_found'), surfacing the
 *     "diverged after N lines" diagnostic when a fuzzy match drifted.
 */

import { distance } from 'fastest-levenshtein';

export type StringReplaceFailureReason = 'ambiguous' | 'not_found' | 'no_op';

/**
 * Thrown when a replacement cannot be applied SAFELY. Carries a discriminated
 * `reason` so callers can branch, and a model-facing `message` that tells the
 * model how to recover (add context / re-read the file).
 */
export class StringReplaceError extends Error {
  readonly reason: StringReplaceFailureReason;

  constructor(reason: StringReplaceFailureReason, message: string) {
    super(message);
    this.name = 'StringReplaceError';
    this.reason = reason;
  }
}

/** Which branch of the cascade produced the applied edit. */
export type StringReplaceMatchType =
  | 'exact'
  | 'whitespace-normalized'
  | 'replace-lines'
  | 'replace-in-line'
  | 'delete-line';

export interface StringReplaceResult {
  /** Which cascade branch matched (for logging / model feedback). */
  matchType: StringReplaceMatchType;
  /** The full new file content with the single block replaced. */
  newContent: string;
  /** 0-based line index where the replacement began (best effort). */
  startLine: number;
}

// --- Verbatim helpers from mastra-code file-editor.ts ------------------------

function removeWhitespace(str: string): string {
  return str
    .replace(/\t/g, '') // tabs to spaces
    .replace(/ +/g, '') // collapse multiple spaces
    .replace(/^ +| +$/gm, '') // trim each line
    .replace(/\r?\n/g, '\n')
    .replace(/\s/g, '');
}

function removeVaryingChars(str: string): string {
  return (
    removeWhitespace(str)
      .replaceAll('\n', '')
      .replaceAll("'", '')
      .replaceAll('"', '')
      .replaceAll('`', '')
      // .replaceAll(`;`, ``) // this sometimes causes an extra ; to be printed!
      .replaceAll('\\r', '')
  );
}

function removeLeadingLineNumbers(str: string): string {
  return str
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\s*/, ''))
    .join('\n');
}

function splitToEscapedLines(str: string): string[] {
  return str.split('\n').map((line: string) => line.replaceAll('\n', '\\n'));
}

/** Count non-overlapping exact occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    count += 1;
    from = index + needle.length;
  }
  return count;
}

// --- Cascade branches --------------------------------------------------------

/**
 * Phase 1: exact substring match. Replaces ONLY the single located occurrence by
 * index — NEVER `split().join()`, which would rewrite EVERY occurrence and
 * silently corrupt a file with a duplicated block. The caller
 * ({@link applyStringReplace}) guarantees exactly one occurrence via
 * {@link countOccurrences} before reaching here (>1 throws 'ambiguous').
 */
function tryExactMatch(
  fileContent: string,
  oldStr: string,
  newStr: string
): StringReplaceResult | undefined {
  const index = fileContent.indexOf(oldStr);
  if (index === -1) {
    return;
  }
  const newContent =
    fileContent.slice(0, index) + newStr + fileContent.slice(index + oldStr.length);
  // 0-based start line of the (single) occurrence.
  const startLine = fileContent.slice(0, index).split('\n').length - 1;
  return { newContent, matchType: 'exact', startLine };
}

interface NormalizedWindow {
  end: number;
  start: number;
}

/**
 * Locate every DISTINCT, non-overlapping line window whose whitespace-normalized
 * form equals `normalizedOldStr`. Used both to apply the single-match edit AND
 * to detect ambiguity: the exact guard counts EXACT occurrences, so when a block
 * matches only AFTER whitespace normalization it sees 0 — without this the
 * normalized branch would silently edit the FIRST of several matching locations
 * (a wrong-location edit). Matches advance past their window so the same span is
 * never counted twice.
 */
function findNormalizedWindows(
  lines: readonly string[],
  normalizedOldStr: string,
  normalizeWhitespace: (str: string) => string,
  maxWindow: number
): NormalizedWindow[] {
  const windows: NormalizedWindow[] = [];
  let i = 0;
  while (i < lines.length) {
    let matched: NormalizedWindow | undefined;
    for (let j = i; j <= Math.min(i + maxWindow, lines.length - 1); j += 1) {
      const candidate = lines.slice(i, j + 1).join('\n');
      if (normalizeWhitespace(candidate) === normalizedOldStr) {
        matched = { start: i, end: j };
        break;
      }
    }
    if (matched) {
      windows.push(matched);
      // Advance past the matched window so overlapping spans of the SAME match
      // are never double-counted as distinct locations.
      i = matched.end + 1;
    } else {
      i += 1;
    }
  }
  return windows;
}

/**
 * Phase 2: whitespace-normalized match (only difference is whitespace).
 *
 * AMBIGUITY GUARD: if the normalized old_str matches MORE THAN ONE location, the
 * edit is ambiguous and silently editing the first would corrupt code — THROW
 * 'ambiguous' (consistent with the exact and single-line fuzzy guards), demanding
 * surrounding context. Applies the edit only when exactly one window matches.
 */
function tryWhitespaceNormalizedMatch(
  fileContent: string,
  oldStr: string,
  newStr: string
): StringReplaceResult | undefined {
  const normalizeWhitespace = (str: string): string => str.replace(/\s+/g, ' ').trim();
  const normalizedOldStr = normalizeWhitespace(oldStr);
  const normalizedContent = normalizeWhitespace(fileContent);
  if (!normalizedContent.includes(normalizedOldStr)) {
    return;
  }

  const lines = fileContent.split('\n');
  const originalOldLineCount = oldStr.split('\n').length;
  const maxWindow = originalOldLineCount + 5;
  const windows = findNormalizedWindows(lines, normalizedOldStr, normalizeWhitespace, maxWindow);
  const bestMatch = windows[0];
  if (!bestMatch) {
    return;
  }
  if (windows.length > 1) {
    const matchLines = windows.map((window) => window.start + 1).join(', ');
    throw new StringReplaceError(
      'ambiguous',
      `old_str matches ${windows.length} locations after whitespace normalization (near lines ${matchLines}), but only one block can be edited. Add surrounding lines to old_str so it uniquely identifies one location, then retry.`
    );
  }

  const beforeLines = lines.slice(0, bestMatch.start);
  const afterLines = lines.slice(bestMatch.end + 1);
  const newContent = [...beforeLines, newStr, ...afterLines].join('\n');
  return { newContent, matchType: 'whitespace-normalized', startLine: bestMatch.start };
}

interface FuzzyBestMatch {
  end?: number;
  start: number;
  type: 'replace-lines' | 'replace-in-line' | 'delete-line';
}

/**
 * Phase 3: char-level / Levenshtein-fuzzy whitespace-agnostic match. Ported
 * verbatim from mastra-code's `strReplace` fuzzy section. Throws on ambiguity or
 * no-match rather than returning a failure string.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported verbatim from the proven mastra-code matcher; loosening the structure risks corrupting files (see file docstring).
function tryFuzzyMatch(
  fileContent: string,
  rawOldStr: string,
  rawNewStr: string
): StringReplaceResult {
  let oldStr = removeLeadingLineNumbers(rawOldStr);
  let newStr = removeLeadingLineNumbers(rawNewStr);
  if (oldStr.startsWith('\\\n')) {
    oldStr = oldStr.slice('\\\n'.length);
  }
  if (newStr.startsWith('\\\n')) {
    newStr = newStr.slice('\\\n'.length);
  }

  const oldLinesSplit = oldStr.split('\n');
  const oldLinesOriginal = oldLinesSplit.filter((l, i) => {
    if (i === 0) {
      return removeWhitespace(l) !== '';
    }
    if (i + 1 !== oldLinesSplit.length) {
      return true;
    }
    // only keep last item if it's not an empty string
    return removeWhitespace(l) !== '';
  });
  const oldLines = oldLinesOriginal.map(removeWhitespace);
  // The first normalized old line, used throughout the per-line matcher. Empty
  // when old_str collapsed to nothing (caught by the not-found throw below).
  const firstOldLine = oldLines[0] ?? '';

  const fileLines = splitToEscapedLines(fileContent);
  const normFileLines = fileLines.map(removeWhitespace);

  const bestMatch: FuzzyBestMatch = { start: -1, type: 'replace-lines' };
  const isSingleLineReplacement = oldLines.length === 1;

  // SINGLE-LINE AMBIGUITY GUARD (mirrors mastra-code file-editor.ts:262-273):
  // a single-line oldStr matching MULTIPLE lines must REFUSE — guessing one
  // would land the edit in the wrong place and silently corrupt code.
  const matchLineNumbers = normFileLines
    .map((l: string, index: number) => (l === firstOldLine ? index + 1 : null))
    .filter((value): value is number => value !== null);
  if (isSingleLineReplacement && matchLineNumbers.length > 1) {
    throw new StringReplaceError(
      'ambiguous',
      `The single-line old_str matches ${matchLineNumbers.length} locations (lines ${matchLineNumbers.join(
        ', '
      )}). Add surrounding lines to old_str so it uniquely identifies one location, then retry.`
    );
  }

  let divergedMessage: string | undefined;
  let divergenceAfterX = 0;

  // Char-level prefix walk (mastra-code file-editor.ts:276-332).
  const fileNoSpace = removeVaryingChars(fileContent);
  const oldStringNoSpace = removeVaryingChars(oldStr);
  // biome-ignore lint/style/noSubstr: ported verbatim — substring(0, -1) clamps the negative end to 0 (yielding ""), which slice(0, -1) does NOT replicate (it would drop the last char). The quirky guard is intentional mastra-code behaviour; do not "fix" it.
  if (fileNoSpace.includes(oldStringNoSpace.substring(0, -1))) {
    let oldStringNoSpaceBuffer = oldStringNoSpace;
    let startIndex: number | null = null;
    let endIndex: number | null = null;
    for (const [index, line] of splitToEscapedLines(fileContent).entries()) {
      const lineNoSpace = removeVaryingChars(line);
      if (lineNoSpace === '' && !startIndex) {
        continue;
      }
      const startsWith = oldStringNoSpaceBuffer.startsWith(lineNoSpace);
      const startsWithNoDanglingCommaTho =
        !startsWith &&
        lineNoSpace.endsWith(',') &&
        oldStringNoSpaceBuffer.slice(lineNoSpace.length - 1).startsWith(')') &&
        oldStringNoSpaceBuffer.startsWith(lineNoSpace.slice(0, lineNoSpace.length - 1));
      if (startsWith || startsWithNoDanglingCommaTho) {
        if (startIndex === null) {
          startIndex = index;
        }
        oldStringNoSpaceBuffer = oldStringNoSpaceBuffer.slice(
          startsWithNoDanglingCommaTho ? lineNoSpace.length - 1 : lineNoSpace.length
        );
        if (oldStringNoSpaceBuffer.length === 0 && startIndex !== null) {
          endIndex = index;
          break;
        }
      } else if (startIndex !== null) {
        // diverged from a partial match. reset
        startIndex = null;
        oldStringNoSpaceBuffer = oldStringNoSpace;
      }
    }
    if (startIndex !== null && endIndex !== null) {
      bestMatch.start = startIndex;
      bestMatch.end = endIndex;
    }
  }

  // Per-line Levenshtein-fuzzy match (mastra-code file-editor.ts:333-401).
  for (const [index, normLine] of normFileLines.entries()) {
    if (!normLine) {
      continue;
    }
    if (bestMatch.end !== undefined) {
      break; // already matched above
    }
    const firstDistance = distance(firstOldLine, normLine || '');
    const firstPercentDiff = (firstDistance / (normLine?.length || 0)) * 100;
    if (isSingleLineReplacement && (normLine === firstOldLine || normLine.includes(firstOldLine))) {
      bestMatch.start = index;
      bestMatch.type = 'replace-in-line';
      continue;
    }
    if (firstOldLine === normLine || firstPercentDiff < 5) {
      let isMatching = true;
      let matchingLineCount = 0;
      for (const [matchIndex, oldLine] of oldLines.entries()) {
        const innerNormLine = normFileLines[index + matchIndex];
        const innerDistance = distance(oldLine, normFileLines[index + matchIndex] ?? '');
        const innerPercentDiff = (innerDistance / (innerNormLine?.length || 1)) * 100;
        const remainingLines = oldLines.length - matchingLineCount;
        const percentLinesRemaining = (remainingLines / oldLines.length) * 100;
        const isMatch = oldLine === innerNormLine || innerPercentDiff < 5;
        const fewLinesAreLeft = oldLines.length >= 30 && percentLinesRemaining < 1;
        if (isMatch || fewLinesAreLeft) {
          matchingLineCount += 1;
        } else {
          const message = `old_str matching diverged after ${matchingLineCount} matching lines.\nExpected line from old_str: \`${oldLinesOriginal[matchIndex]}\` (line ${matchIndex + 1} in old_str), found line: \`${fileLines[index + matchIndex]}\` (line ${index + 1 + matchIndex} in file). ${remainingLines - 1} lines remained to compare but they were not checked due to this line not matching.\n\nHere are the lines that did match up until the old_str diverged:\n\n${oldLinesOriginal.slice(0, matchIndex).join('\n')}\n\nHere are the remaining lines you would've had to provide for the old_str to match:\n\n${fileLines
            .slice(index + matchIndex, index + matchIndex + remainingLines)
            .join('\n')}`;
          if (matchingLineCount > divergenceAfterX) {
            divergenceAfterX = matchingLineCount;
            divergedMessage = message;
          }
          isMatching = false;
          break;
        }
      }
      if (isMatching) {
        bestMatch.start = index;
        break;
      }
    }
  }

  // Pure deletion of a single line / blank old_str (mastra-code file-editor.ts:402-411).
  if (bestMatch.start === -1 && (isSingleLineReplacement || oldStr === '\n') && newStr === '') {
    // mastra-code only takes this branch with an explicit start_line; we have no
    // start_line in our surface, so a deletion still needs a located match. Fall
    // through to the not-found throw below.
  }

  if (bestMatch.start === -1) {
    // NO sufficiently close match — REFUSE (mastra-code returns a string here; we
    // throw per no-silent-fallbacks). Surface the diverged diagnostic if a fuzzy
    // match drifted, so the model can adjust its next old_str.
    throw new StringReplaceError(
      'not_found',
      `No sufficiently close match for old_str was found. Nothing was changed.${
        divergedMessage ? `\n\n${divergedMessage}` : ''
      }\n\nRe-read the file and provide an old_str that matches the current content exactly.`
    );
  }

  // Apply the located edit (mastra-code file-editor.ts:417-453).
  let newContent = '';
  if (bestMatch.type === 'replace-lines') {
    const newFileLines = [
      ...fileLines.slice(0, bestMatch.start),
      ...(newStr ? newStr.split('\n') : []),
      ...fileLines.slice(
        bestMatch.end === undefined ? bestMatch.start + oldLines.length : bestMatch.end + 1
      ),
    ];
    newContent = newFileLines.join('\n');
  } else if (bestMatch.type === 'replace-in-line') {
    const [firstNew, ...restNew] = newStr ? newStr.split('\n') : [];
    const newFileLines = [
      ...fileLines.slice(0, bestMatch.start),
      ...(restNew?.length
        ? [firstNew, ...restNew]
        : [
            fileLines.at(bestMatch.start)?.replace(oldLinesOriginal[0] ?? '', firstNew || '') ?? '',
          ]),
      ...fileLines.slice(bestMatch.start + 1),
    ];
    newContent = newFileLines.join('\n');
  } else {
    const newFileLines = [
      ...fileLines.slice(0, bestMatch.start),
      ...fileLines.slice(bestMatch.start + 1),
    ];
    newContent = newFileLines.join('\n');
  }

  return { newContent, matchType: bestMatch.type, startLine: bestMatch.start };
}

/**
 * Guard against a "successful" no-op: a fuzzy branch (notably `replace-in-line`,
 * which locates a line by normalized-includes but then does a RAW `.replace`
 * that can match nothing when whitespace differs) can return content identical
 * to the input. Reporting replaced=true on an unchanged file is a silent failure
 * — the model believes its edit landed when it did not. Throw instead so the
 * caller re-reads and supplies a matching old_str (no silent fallbacks).
 */
function assertChanged(result: StringReplaceResult, fileContent: string): StringReplaceResult {
  if (result.newContent === fileContent) {
    throw new StringReplaceError(
      'not_found',
      'old_str was located but the replacement produced no change (the matched text did not align well enough to edit). Re-read the file and provide an old_str that matches the current content exactly.'
    );
  }
  return result;
}

/**
 * Replace exactly one occurrence of `oldStr` with `newStr` in `fileContent`,
 * using the fuzzy-match cascade. Returns the new content; THROWS a
 * {@link StringReplaceError} when the match is ambiguous, absent, or a no-op.
 *
 * Input size is bounded by the desktop read tool's ~2 MB byte cap (the file is
 * read through `readWorkspaceTextFile` before this runs), so the matcher needs
 * no separate length bound of its own.
 */
export function applyStringReplace(args: {
  fileContent: string;
  oldStr: string;
  newStr: string;
}): StringReplaceResult {
  const { fileContent, oldStr, newStr } = args;

  if (oldStr === newStr) {
    throw new StringReplaceError(
      'no_op',
      'old_str and new_str are identical, so the edit would change nothing.'
    );
  }
  if (oldStr.length === 0) {
    throw new StringReplaceError(
      'not_found',
      'old_str is empty. Provide the exact block of text to replace.'
    );
  }

  // EXACT AMBIGUITY GUARD (applies to ANY old_str, single OR multi-line). The
  // tool's contract is to replace exactly ONE block. If old_str appears exactly
  // more than once, the edit is ambiguous and applying it to every match (or
  // guessing one) would silently corrupt code — the precise failure the model is
  // promised never happens. Refuse here (no silent fallbacks) and demand
  // surrounding context BEFORE the exact/whitespace branches run, so a duplicated
  // block can never be replace-all'd no matter which branch would match it.
  const exactOccurrences = countOccurrences(fileContent, oldStr);
  if (exactOccurrences > 1) {
    throw new StringReplaceError(
      'ambiguous',
      `old_str matches ${exactOccurrences} locations exactly, but only one block can be edited. Add surrounding lines to old_str so it uniquely identifies one location, then retry.`
    );
  }

  // Phase 1: exact (replaces only the single located occurrence, by index).
  const exact = tryExactMatch(fileContent, oldStr, newStr);
  if (exact) {
    return assertChanged(exact, fileContent);
  }

  // Phase 2: whitespace-normalized.
  const whitespace = tryWhitespaceNormalizedMatch(fileContent, oldStr, newStr);
  if (whitespace) {
    return assertChanged(whitespace, fileContent);
  }

  // Phase 3: char-level / Levenshtein-fuzzy (throws on ambiguity / no-match).
  return assertChanged(tryFuzzyMatch(fileContent, oldStr, newStr), fileContent);
}
