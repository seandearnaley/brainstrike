/**
 * Per-line grep matching shared by the live grep pass: absolute line numbers
 * and context lines, with real JS RegExp semantics from the injected matcher.
 */

import type { GrepMatch } from '@brainstrike/assistant-contract';
import type { LineMatcher } from '@brainstrike/utils/grep-line-matcher';

/**
 * Run `matcher` over the lines of one file's content and return the matching
 * lines as `GrepMatch`es with absolute line numbers and ±`contextLines` of
 * surrounding text. Pure (no I/O).
 *
 * `startLine` is the 1-based line number of the file's first line (always 1 for
 * a whole on-disk file; chunk-relative for the indexed path).
 */
export function collectGrepMatchesInContent(args: {
  content: string;
  matcher: LineMatcher;
  contextLines: number;
  path: string;
  startLine: number;
  rootId?: string | null;
  rootName?: string | null;
}): GrepMatch[] {
  const lines = args.content.split('\n');
  const matches: GrepMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (!args.matcher.matches(lineText)) {
      continue;
    }
    matches.push({
      after: lines.slice(index + 1, index + 1 + args.contextLines),
      before: lines.slice(Math.max(0, index - args.contextLines), index),
      line: args.startLine + index,
      lineText,
      path: args.path,
      ...(args.rootId === undefined ? {} : { rootId: args.rootId }),
      ...(args.rootName === undefined ? {} : { rootName: args.rootName }),
    });
  }
  return matches;
}
