/**
 * Git's patch to @pierre/diffs metadata (ADR-0036). The renderer parses the
 * patch git wrote and never diffs again, so the drawn lines are the lines git
 * counted.
 */
import type { ChangedFileStatus, StructuredFileDiff } from '@brainstrike/types';
import {
  type ChangeTypes,
  type FileDiffLoadedChangedFiles,
  type FileDiffMetadata,
  type Hunk,
  processFile,
} from '@pierre/diffs';

export type DiffSide = 'additions' | 'deletions';

/**
 * Where a hunk's last change, as @pierre/diffs groups it, ends as drawn: its
 * last added line, or its last removed one when it adds none. Side by side, a
 * change that removes more lines than it adds ends on the removed side.
 */
export function lastChangedLine(
  hunk: Hunk,
  diffStyle: 'split' | 'unified'
): { readonly lineNumber: number; readonly side: DiffSide } | null {
  const change = hunk.hunkContent.findLast((content) => content.type === 'change');
  if (change?.type !== 'change') {
    return null;
  }
  const added =
    change.additions > 0 && (diffStyle === 'unified' || change.additions >= change.deletions);
  // The hunk's lines of one side are consecutive, so a change's offset into
  // the hunk is its offset into the file from the hunk's first line.
  const [first, hunkIndex, changeIndex, count] = added
    ? [hunk.additionStart, hunk.additionLineIndex, change.additionLineIndex, change.additions]
    : [hunk.deletionStart, hunk.deletionLineIndex, change.deletionLineIndex, change.deletions];
  return {
    lineNumber: first + changeIndex - hunkIndex + count - 1,
    side: added ? 'additions' : 'deletions',
  };
}

/**
 * Parses git's diff of one file. With both sides the diff can expand its
 * unchanged lines; without them it holds the patch's lines only. Throws when
 * the text is not one file's diff.
 *
 * Git writes a type change (a file replaced by a symlink, or back) as the old
 * entry's deletion then the new one's addition. The parser names the file by
 * its first section, so a type change reads as a change with both sides.
 */
export function parseFilePatch(
  patch: string,
  sides?: FileDiffLoadedChangedFiles | null
): FileDiffMetadata {
  const metadata = processFile(patch, {
    isGitDiff: true,
    throwOnError: true,
    ...(sides ? { newFile: sides.newFile, oldFile: sides.oldFile } : {}),
  });
  if (!metadata?.name) {
    throw new Error('The patch holds no file diff.');
  }
  const typeChange =
    (metadata.type === 'deleted' && metadata.hunks.some((hunk) => hunk.additionCount > 0)) ||
    (metadata.type === 'new' && metadata.hunks.some((hunk) => hunk.deletionCount > 0));
  return typeChange ? { ...metadata, type: 'change' } : metadata;
}

const CHANGE_TYPE: Record<ChangedFileStatus, ChangeTypes> = {
  added: 'new',
  deleted: 'deleted',
  modified: 'change',
  renamed: 'rename-pure',
  untracked: 'new',
};

/** A file the view has no lines for yet: binary, or not loaded. */
export function emptyFileDiff(
  path: string,
  oldPath: string | undefined,
  status: ChangedFileStatus
): FileDiffMetadata {
  return {
    additionCharacterCount: 0,
    additionLines: [],
    deletionCharacterCount: 0,
    deletionLines: [],
    hunks: [],
    isPartial: true,
    name: path,
    ...(oldPath === undefined ? {} : { prevName: oldPath }),
    splitLineCount: 0,
    type: CHANGE_TYPE[status],
    unifiedLineCount: 0,
  };
}

/** The diff a loaded file draws, or null for a binary file. */
export function loadedFileDiff(diff: StructuredFileDiff): FileDiffMetadata | null {
  return diff.content.kind === 'binary' ? null : parseFilePatch(diff.content.patch, sidesOf(diff));
}

/**
 * Both sides of a changed or renamed file, for expanding its unchanged lines.
 * Null when git sent no sides: a side over the size cap, or an added or
 * deleted file, whose patch already holds every line.
 */
export function sidesOf(diff: StructuredFileDiff): FileDiffLoadedChangedFiles | null {
  const { content } = diff;
  if (content.kind !== 'full' || content.newContent === null || content.oldContent === null) {
    return null;
  }
  return {
    newFile: { contents: content.newContent, name: diff.path },
    oldFile: { contents: content.oldContent, name: diff.oldPath ?? diff.path },
  };
}

/** Stands for the folded lines a range crosses, so a quote never reads as adjacent lines. */
export const FOLDED_LINES = '⋯';

/**
 * One side's file lines `start`–`end` that the diff holds, without line
 * endings. Lines the diff does not hold (folded unchanged lines between two
 * hunks) become one {@link FOLDED_LINES} line.
 */
export function sideLines(
  fileDiff: FileDiffMetadata,
  side: DiffSide,
  start: number,
  end: number
): string[] {
  const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  const result: string[] = [];
  let folded = false;
  for (let line = start; line <= end; line += 1) {
    const index = lineIndex(fileDiff, side, line);
    const text = index === null ? undefined : lines[index];
    if (text === undefined) {
      folded = result.length > 0;
      continue;
    }
    if (folded) {
      result.push(FOLDED_LINES);
      folded = false;
    }
    result.push(text.replace(/\r?\n$/u, ''));
  }
  return result;
}

function lineIndex(fileDiff: FileDiffMetadata, side: DiffSide, line: number): number | null {
  if (!fileDiff.isPartial) {
    return line - 1;
  }
  for (const hunk of fileDiff.hunks) {
    const first = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    if (line >= first && line < first + count) {
      const base = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex;
      return base + (line - first);
    }
  }
  return null;
}
