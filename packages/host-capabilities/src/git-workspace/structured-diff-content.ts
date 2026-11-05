/**
 * The one owner of how git's diff of a file becomes the shared payload
 * (ADR-0036): the pinned `git diff` output format, the per-side content cap,
 * the per-file patch bound and the view's patch budget. Both diff engines use
 * it, git scopes (`git-structured-diff.ts`, `changeset-git-scope.ts`) and
 * snapshot turns (`snapshot-service.ts`, `changeset-snapshot-view.ts`), so a
 * file's patch has the same text and limits whichever engine made it.
 *
 * Pure: no I/O. Each engine runs git its own way and hands the capture here.
 */

import { createHash } from 'node:crypto';
import type { ChangedFileEntry, StructuredFileDiffContent } from '@brainstrike/types';

/**
 * Largest side inlined as full text. A larger side is never read: the file's
 * payload is `hunks-only` (spec §11 Q3). Kept in nominal parity with the
 * file-mutation tools' per-file write cap; move the two together.
 */
export const STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Largest patch, in UTF-16 code units, one view entry carries. A larger file
 * loads its own diff when opened, which carries git's whole patch up to the
 * runner's 4 MB capture ceiling (`GIT_MAX_BUFFER_BYTES`).
 */
export const PATCH_BOUND = 1_000_000;

/** Total UTF-8 size of the patches one `ChangesetView` carries in its entries. */
export const CHANGESET_VIEW_PATCH_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * One side of a two-sided diff, size-gated before any content is read:
 * absent (added/deleted), over the cap (size known, content never read), or
 * read in full.
 */
export type DiffSide =
  | { readonly content: Buffer; readonly kind: 'present' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'over-cap'; readonly size: number };

/** Git's patch output as the runner captured it. */
export interface PatchCapture {
  readonly text: string;
  /** True when the runner cut the output at its capture ceiling. */
  readonly truncated: boolean;
}

/**
 * A repository's `core.fsmonitor` names a command git runs whenever it loads
 * the index to read it or compare it with the working tree. Reading changes
 * for a view or a file's diff never runs it.
 */
export const NO_FSMONITOR: readonly string[] = ['-c', 'core.fsmonitor=false'];

/**
 * Settings with no command-line flag. `diff.suppressBlankEmpty` would drop the
 * leading space of a blank context line, which no patch parser accepts.
 * `core.quotePath=false` keeps non-ASCII names readable; git still quotes
 * control characters, `"` and `\`.
 */
const PINNED_CONFIG = [
  ...NO_FSMONITOR,
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.suppressBlankEmpty=false',
];

/**
 * Flags that decide which lines a diff marks, whatever the user's config
 * says: no external diff or textconv driver, and git's default algorithm and
 * heuristic (`diff.algorithm`, `diff.indentHeuristic`). Numstat and patch both
 * take them, so a file's counts and its drawn lines always agree.
 */
const LINE_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--diff-algorithm=myers',
  '--indent-heuristic',
];

/**
 * Flags that fix the patch text: `a/` and `b/` prefixes (`diff.noprefix`,
 * `diff.mnemonicPrefix`), three lines of context with no hunk merging
 * (`diff.context`, `diff.interHunkContext`), full object ids (`core.abbrev`)
 * and short submodule lines (`diff.submodule`). Patch only: `-U` turns on
 * patch output, even beside `--numstat`.
 */
const PATCH_FLAGS = [
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-U3',
  '--inter-hunk-context=0',
  '--full-index',
  '--submodule=short',
];

/** `git diff` with the pinned line flags, then `args`: for numstat and listings. */
export function pinnedDiffArgs(args: readonly string[]): string[] {
  return [...PINNED_CONFIG, 'diff', ...LINE_FLAGS, ...args];
}

/** `git diff` printing git's patch in the pinned format, then `args`. */
export function pinnedPatchArgs(args: readonly string[]): string[] {
  return [...PINNED_CONFIG, 'diff', ...LINE_FLAGS, ...PATCH_FLAGS, ...args];
}

/** `git status` of every file under `pathspec`, untracked ones included, for a listing. */
export function pinnedStatusArgs(pathspec: string): string[] {
  return [
    ...NO_FSMONITOR,
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
    '-z',
    '--',
    pathspec,
  ];
}

/**
 * A view entry's {@link ChangedFileEntry.revision}: a hash of its status,
 * rename source, counts and git's whole patch for it. Both engines use it,
 * so a files target names a file as the view drew it, and the host refuses
 * the file once the same listing reads differently.
 */
export function fileRevision(
  file: Pick<ChangedFileEntry, 'additions' | 'deletions' | 'status'> & {
    readonly oldPath?: string | null | undefined;
    readonly patch: string | null;
  }
): string {
  const drawn = [file.status, file.oldPath ?? null, file.additions, file.deletions, file.patch];
  return createHash('sha256').update(JSON.stringify(drawn)).digest('hex');
}

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = '@@ ';
/** Git's marker for a pair it treats as binary (content, attributes or driver). */
const BINARY_PATCH_LINE = /^Binary files /mu;

/**
 * The whole patch, or, when the runner cut the capture at its ceiling, the
 * patch up to its last whole hunk: the cut lands where the last, possibly
 * partial, hunk or file section begins, so every hunk kept is complete and
 * the patch parses.
 */
function boundPatch({ text, truncated }: PatchCapture): {
  patch: string;
  patchTruncated: boolean;
} {
  if (!truncated) {
    return { patch: text, patchTruncated: false };
  }
  const cut =
    Math.max(text.lastIndexOf(`\n${HUNK_HEADER}`), text.lastIndexOf(`\n${FILE_HEADER}`)) + 1;
  return { patch: text.slice(0, cut), patchTruncated: true };
}

function sideText(side: DiffSide): string | null {
  return side.kind === 'present' ? side.content.toString('utf8') : null;
}

function overCapReason(
  oldSide: DiffSide,
  newSide: DiffSide
): 'over-cap-both' | 'over-cap-new' | 'over-cap-old' | null {
  const oldOver = oldSide.kind === 'over-cap';
  const newOver = newSide.kind === 'over-cap';
  if (oldOver && newOver) {
    return 'over-cap-both';
  }
  if (oldOver) {
    return 'over-cap-old';
  }
  return newOver ? 'over-cap-new' : null;
}

/**
 * The payload for one file from its sides and git's patch. Binary is git's
 * call, as in its numstat, so a file's kind and its counts never disagree.
 * `full` needs both sides inlined and the whole patch; otherwise the payload
 * is `hunks-only`, naming the side over the cap or the patch overflow.
 */
export function fileDiffContent(
  oldSide: DiffSide,
  newSide: DiffSide,
  capture: PatchCapture
): StructuredFileDiffContent {
  if (BINARY_PATCH_LINE.test(capture.text)) {
    return { kind: 'binary' };
  }
  const { patch, patchTruncated } = boundPatch(capture);
  const reason = overCapReason(oldSide, newSide);
  if (reason === null && !patchTruncated) {
    return { kind: 'full', newContent: sideText(newSide), oldContent: sideText(oldSide), patch };
  }
  return { kind: 'hunks-only', patch, patchTruncated, reason: reason ?? 'diff-overflow' };
}

/** The file's whole patch, or null when there is none to draw (binary, or cut short). */
export function completePatch(content: StructuredFileDiffContent): string | null {
  if (content.kind === 'binary' || (content.kind === 'hunks-only' && content.patchTruncated)) {
    return null;
  }
  return content.patch;
}

/**
 * Give each view entry its patch in listing order while the patches' total
 * stays within {@link CHANGESET_VIEW_PATCH_BUDGET_BYTES}. An entry that does
 * not fit, or whose patch is over {@link PATCH_BOUND}, gets null and loads its
 * diff on demand; later, smaller entries may still fit.
 */
export function boundViewPatches<T extends { readonly patch: string | null }>(
  entries: readonly T[]
): T[] {
  let spent = 0;
  return entries.map((entry) => {
    if (entry.patch === null) {
      return entry;
    }
    const size = Buffer.byteLength(entry.patch, 'utf8');
    if (entry.patch.length > PATCH_BOUND || spent + size > CHANGESET_VIEW_PATCH_BUDGET_BYTES) {
      return { ...entry, patch: null };
    }
    spent += size;
    return entry;
  });
}

/** Git's C escapes; any other control character is written as three octal digits. */
const C_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

/** What git quotes in a header path under `core.quotePath=false` (see {@link PINNED_CONFIG}). */
function mustQuote(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c;
}

function quoteHeaderPath(prefixed: string): string {
  const characters = [...prefixed];
  if (!characters.some(mustQuote)) {
    return prefixed;
  }
  const escaped = characters.map((character) => {
    if (!mustQuote(character)) {
      return character;
    }
    const code = character.codePointAt(0) ?? 0;
    return C_ESCAPES.get(code) ?? `\\${code.toString(8).padStart(3, '0')}`;
  });
  return `"${escaped.join('')}"`;
}

/** The `diff --git` line git writes for a file listed at `newPath` (renamed from `oldPath`). */
export function diffGitHeader(oldPath: string, newPath: string): string {
  return `${FILE_HEADER}${quoteHeaderPath(`a/${oldPath}`)} ${quoteHeaderPath(`b/${newPath}`)}`;
}

/**
 * Split a many-file patch into each file's patch, keyed by its `diff --git`
 * line. A type change (file to symlink) is two sections under one line; they
 * stay together, as in that file's own patch. A cut capture drops its last
 * file, which may be partial, with both halves of a type change.
 */
export function splitPatchByFile({ text, truncated }: PatchCapture): ReadonlyMap<string, string> {
  const starts: number[] = text.length > 0 ? [0] : [];
  for (
    let at = text.indexOf(`\n${FILE_HEADER}`);
    at !== -1;
    at = text.indexOf(`\n${FILE_HEADER}`, at + 1)
  ) {
    starts.push(at + 1);
  }
  const headerAt = (start: number): string => {
    const newline = text.indexOf('\n', start);
    return text.slice(start, newline === -1 ? text.length : newline);
  };
  const sections = new Map<string, string>();
  const whole = truncated ? starts.length - 1 : starts.length;
  for (let index = 0; index < whole; index += 1) {
    const start = starts[index] ?? 0;
    const header = headerAt(start);
    sections.set(header, `${sections.get(header) ?? ''}${text.slice(start, starts[index + 1])}`);
  }
  const cut = truncated ? starts.at(-1) : undefined;
  if (cut !== undefined) {
    // A cut type change keeps neither half: its file loads its own diff.
    sections.delete(headerAt(cut));
  }
  return sections;
}
