/**
 * What a waiting file call would change (ADR-0036): the file's whole text now
 * and after the call, which jsdiff diffs (the one diff the renderer computes,
 * bounded by the lines that changed) and @pierre/diffs draws. Line numbers are the file's own, unchanged lines fold and expand,
 * and CodeView draws only the rows in view. The caller's line already names
 * the file, so the diff draws no header.
 */
import {
  type CodeViewItem,
  type FileContents,
  type FileDiffMetadata,
  parseDiffFromFile,
  processFile,
} from '@pierre/diffs';
import { CodeView, type CodeViewReactOptions } from '@pierre/diffs/react';
import { createTwoFilesPatch } from 'diff';
import { type ReactElement, useMemo } from 'react';
import { cn } from '../lib/utils';
import { useDiffAppearance } from './diff-appearance';

export interface FileDiffViewProps {
  /** The file's text after the change, or null when the change deletes it. */
  readonly after: string | null;
  readonly ariaLabel: string;
  /** The file's text now, or null when the change creates it. */
  readonly before: string | null;
  /** Sizes the scroll region; it fills its parent otherwise. */
  readonly className?: string | undefined;
  /** Names the language for highlighting. */
  readonly path: string;
  readonly testId?: string | undefined;
}

/**
 * Highlighting tokenizes the whole file on the main thread, seconds for a file
 * of tens of thousands of lines, so a longer file draws as plain text and the
 * card stays responsive. 5,000 lines covers nearly every source file.
 */
const HIGHLIGHT_MAX_LINES = 5000;

/**
 * CodeView redraws an item only when its version changes, so each new pair of
 * texts is the next version of the one item.
 */
let drawnPairs = 0;

/**
 * Myers' diff takes time in the square of the lines that changed: a few
 * thousand took seconds on the main thread. Past this many the view says so
 * instead; a change that large reads as a rewrite anyway.
 */
const MAX_CHANGED_LINES = 2000;

function side(path: string, contents: string | null): FileContents | null {
  return contents === null ? null : { contents, name: path };
}

/** The two texts' diff, or undefined when more lines changed than it searches. */
function diffOf(
  path: string,
  before: string | null,
  after: string | null
): FileDiffMetadata | undefined {
  if (before === null || after === null) {
    // Every line of a created or deleted file is a change: nothing to search.
    return parseDiffFromFile(side(path, before), side(path, after));
  }
  const patch = createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    maxEditLength: MAX_CHANGED_LINES,
  });
  if (patch === undefined) {
    return undefined;
  }
  const fileDiff = processFile(patch, {
    newFile: { contents: after, name: path },
    oldFile: { contents: before, name: path },
  });
  if (!fileDiff) {
    throw new Error(`The diff of ${path} did not parse`);
  }
  return fileDiff;
}

export function FileDiffView({
  after,
  ariaLabel,
  before,
  className,
  path,
  testId,
}: FileDiffViewProps): ReactElement {
  const { theme, themeType, unsafeCSS } = useDiffAppearance();
  // Stable props, as the library asks: one parse per change, and lines a
  // person expanded stay expanded across renders.
  const items = useMemo<CodeViewItem<undefined>[] | undefined>(() => {
    const fileDiff = diffOf(path, before, after);
    return fileDiff && [{ fileDiff, id: path, type: 'diff', version: ++drawnPairs }];
  }, [after, before, path]);
  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      diffStyle: 'unified',
      disableFileHeader: true,
      theme,
      themeType,
      tokenizeMaxLength: HIGHLIGHT_MAX_LINES,
      unsafeCSS,
    }),
    [theme, themeType, unsafeCSS]
  );
  return (
    <section aria-label={ariaLabel} className="h-full min-h-0" data-testid={testId}>
      {items ? (
        <CodeView
          className={cn('h-full overflow-auto overscroll-y-contain', className)}
          items={items}
          options={options}
        />
      ) : (
        <p className="text-muted-foreground p-3 text-xs">Too many lines changed to show.</p>
      )}
    </section>
  );
}
