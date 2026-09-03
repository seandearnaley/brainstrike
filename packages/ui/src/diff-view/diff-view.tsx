import { createLogger } from '@brainstrike/logging';
import type { ChangedFileStatus } from '@brainstrike/types';
import {
  defaultHighlightStyle,
  type LanguageSupport,
  syntaxHighlighting,
} from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightSpecialChars,
  lineNumbers,
} from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../button';
import { resolveCodeSurfaceLanguage } from '../code-surface/language';
import { cn } from '../lib/utils';
import {
  buildSlicedTextDiff,
  createSlicedLineNumberFormatter,
  type SlicedTextDiff,
} from './diff-view-slice';
import {
  type DiffViewSource,
  type ResolvedDiffPresentation,
  resolveDiffView,
} from './diff-view-source';

const logger = createLogger('DiffView');

const MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/**
 * Shared theme mirroring {@link CodeSurface} so the diff viewer is visually
 * consistent with the rest of the read-only code surfaces (same font, gutters,
 * and CSS-variable-driven colors). The `.cm-deletedChunk` / `.cm-insertedLine`
 * / `.cm-changedLine` rules tint the diff highlights using the app's
 * destructive / success-ish tokens.
 */
const DIFF_THEME: Extension = EditorView.theme({
  // Merge-view chunk highlighting (tinted via theme tokens so it tracks dark mode).
  '.cm-changedLine': {
    backgroundColor: 'hsl(var(--primary) / 0.08)',
  },
  '.cm-changedText': {
    backgroundColor: 'hsl(var(--primary) / 0.18)',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--foreground))',
    fontFamily: MONO_FONT_FAMILY,
    fontSize: '0.8125rem',
    lineHeight: '1.55',
    minHeight: '100%',
    padding: '0.5rem 0',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'hsl(var(--destructive) / 0.12)',
  },
  '.cm-editor': {
    height: '100%',
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted) / 0.35)',
    borderRight: '1px solid hsl(var(--border))',
    color: 'hsl(var(--muted-foreground))',
  },
  '.cm-insertedLine': {
    backgroundColor: 'hsl(142 70% 45% / 0.14)',
  },
  '.cm-merge-revert': {
    // Read-only diff: hide the revert gutter entirely.
    display: 'none',
  },
  '.cm-scroller': {
    fontFamily: MONO_FONT_FAMILY,
    overflow: 'auto',
  },
  '&': {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    height: '100%',
    minHeight: '100%',
  },
});

/** Read-only + non-editable extensions shared by every editor in the view. */
const READ_ONLY_EXTENSIONS: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

/**
 * Turns off the browser's native spellcheck/autocorrect/autocapitalize on
 * CodeMirror's content DOM. Smoke-test feedback (BST-1114): diff content is
 * source code, not prose, so red squiggles under every "diff"/"const"/"fn"
 * token are noise, not a real spelling issue — and `EditorState.readOnly` /
 * `EditorView.editable.of(false)` do NOT imply this; some browsers still run
 * spellcheck over a read-only-but-still-`contenteditable` surface (CodeMirror
 * keeps `contenteditable` on the content DOM even in read-only mode, since
 * that's what lets selection/copy keep working). Applied via
 * `BASE_EXTENSIONS_NO_GUTTER` so it reaches all three modes this file mounts
 * an editor for — split, unified, and hunks-only.
 */
const DISABLE_NATIVE_SPELLCHECK_EXTENSION: Extension = EditorView.contentAttributes.of({
  autocapitalize: 'off',
  autocorrect: 'off',
  spellcheck: 'false',
});

/**
 * Extensions shared by every editor EXCEPT the hunks-only view — no
 * `lineNumbers()` gutter here (see {@link BASE_EXTENSIONS}'s doc comment).
 */
const BASE_EXTENSIONS_NO_GUTTER: Extension[] = [
  highlightSpecialChars(),
  drawSelection(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.lineWrapping,
  DIFF_THEME,
  DISABLE_NATIVE_SPELLCHECK_EXTENSION,
];

/**
 * Adds the real line-number gutter. Valid ONLY when the mounted doc is a
 * real file (or the full old/new side of one) — the bounded `hunkText`
 * shown by the `hunks-only` branch is NOT a real file; its lines don't map
 * to any single, correct set of absolute positions, so `lineNumbers()`
 * would fabricate them starting from 1 right next to the gutter this
 * feature made authoritative for the full-content case. `hunks-only`
 * therefore builds its editor from {@link BASE_EXTENSIONS_NO_GUTTER}
 * instead of this.
 */
const BASE_EXTENSIONS: Extension[] = [lineNumbers(), ...BASE_EXTENSIONS_NO_GUTTER];

/**
 * Tints `hunkText` lines by their leading `+`/`-` marker, reusing the same
 * `.cm-insertedLine` / `.cm-deletedChunk` theme classes the full-document
 * MergeView uses. The raw unified-diff text has no language grammar (it's
 * not source code in the file's own language — see `BASE_EXTENSIONS`'s note
 * on why no `languageExtension` is passed here either), so this is the
 * cheap substitute for "some visual signal of what changed" without
 * mis-highlighting it as source. Computed once from the (immutable,
 * read-only) `hunkText` string as a static decoration set rather than a
 * reactive `ViewPlugin` — this view's document never changes after
 * construction, so there's nothing to react to.
 */
function buildHunkLineDecorations(hunkText: string): Extension {
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  // CodeMirror's `Doc` normalizes EVERY line break — `\r\n` included — to a
  // single logical line boundary, so splitting on `'\n'` alone leaves a
  // trailing `\r` on each line and drifts `pos` out of sync with the actual
  // document positions on CRLF input (verified: a CRLF hunk fixture silently
  // dropped every decoration under the old split). Splitting on the same
  // break set CodeMirror recognizes keeps `pos` aligned regardless of line
  // ending.
  for (const line of hunkText.split(/\r\n?|\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      builder.add(pos, pos, Decoration.line({ class: 'cm-insertedLine' }));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      builder.add(pos, pos, Decoration.line({ class: 'cm-deletedChunk' }));
    }
    pos += line.length + 1;
  }
  return EditorView.decorations.of(builder.finish());
}

/**
 * Whether the "diff truncated" note should show — `text`'s own `truncated`
 * flag, or `hunks-only`'s `hunkTextTruncated`. Extracted to a plain function
 * (rather than an inline ternary in the component body) to keep `DiffView`'s
 * cognitive-complexity score under Biome's limit.
 */
function resolveTruncatedNoteVisible(presentation: ResolvedDiffPresentation): boolean {
  if (presentation.kind === 'text') {
    return presentation.truncated;
  }
  return presentation.kind === 'hunks-only' && presentation.hunkTextTruncated;
}

/**
 * The two document texts the build effect keys its identity-stable
 * dependency array on (see the effect's comment) — `null` when
 * `presentation.kind !== 'text'`. Extracted to a plain function for the same
 * complexity-budget reason as {@link resolveTruncatedNoteVisible}.
 */
function extractTextDocs(presentation: ResolvedDiffPresentation): {
  modified: string | null;
  original: string | null;
} {
  if (presentation.kind !== 'text') {
    return { modified: null, original: null };
  }
  return { modified: presentation.modified, original: presentation.original };
}

/** `hunkText` when `presentation.kind === 'hunks-only'`, else `null`. */
function extractHunkText(presentation: ResolvedDiffPresentation): string | null {
  return presentation.kind === 'hunks-only' ? presentation.hunkText : null;
}

/**
 * Render-side interactivity thresholds for the `text` presentation's
 * MergeView/unifiedMergeView diff — deliberately distinct from the
 * structured-diff engine's `STRUCTURED_DIFF_CONTENT_CAP_BYTES` (2 MB per
 * side, `apps/desktop/src/assistant-server/git-structured-diff.ts`). That
 * cap answers "will reading this file blow up main-process memory", a much
 * higher bar than "can the renderer's main thread compute a diff and stay
 * interactive". `@codemirror/merge`'s `MergeView` computes an O(n·d) chunk
 * diff SYNCHRONOUSLY on the renderer main thread; a pair of 1–2 MB text
 * sides — comfortably under the service cap — can freeze the whole UI for
 * seconds with no spinner and no way to bail. Below both thresholds, the
 * two sides are small enough to diff interactively; at or above either
 * one, `DiffView` never hands the WHOLE documents to `@codemirror/merge`.
 * It first tries to slice both sides down to just the changed regions using
 * the absolute hunk ranges git already computed in the main process (see
 * `diff-view-slice.ts`) and re-checks THAT pair against these same
 * thresholds; only when there are no hunk ranges to slice around, or the
 * slice is itself still over threshold, does it fall back to a single
 * read-only view of one side with no change highlighting at all (see
 * `resolveOversizedDoc`).
 *
 * `RENDER_SIDE_SIZE_THRESHOLD_BYTES` is measured in JS string `.length`
 * (UTF-16 code units), not exact UTF-8 bytes — encoding the whole string
 * just to threshold-check it would defeat the purpose for genuinely large
 * input. For the overwhelmingly-ASCII content this threshold exists to
 * catch (source, lockfiles, minified bundles), the two are equal; the
 * `RENDER_SIDE_LINE_THRESHOLD` check is the orthogonal backstop for
 * content shapes (e.g. one enormous line) the byte check alone might miss.
 */
const RENDER_SIDE_SIZE_THRESHOLD_BYTES = 256 * 1024;
const RENDER_SIDE_LINE_THRESHOLD = 20_000;

/** Number of lines in `text` (1 + newline count) — a single char-code scan, no array allocation. */
function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* '\n' */) {
      lines += 1;
    }
  }
  return lines;
}

/** Whether either side exceeds the render-side interactivity thresholds above. */
function isTextContentTooLargeToDiffInline(original: string, modified: string): boolean {
  return (
    original.length > RENDER_SIDE_SIZE_THRESHOLD_BYTES ||
    modified.length > RENDER_SIDE_SIZE_THRESHOLD_BYTES ||
    countLines(original) > RENDER_SIDE_LINE_THRESHOLD ||
    countLines(modified) > RENDER_SIDE_LINE_THRESHOLD
  );
}

/**
 * Which side to show read-only when the diff is skipped as too large — the
 * new side, except for a deletion (`status === 'deleted'`, structured mode
 * only) or the equivalent legacy-mode shape (an empty `modified` with
 * non-empty `original` — the legacy `strings` source carries no `status`
 * concept to check directly), where the new side is empty/absent and the
 * old side is the only one worth showing.
 */
function pickOversizedDoc(
  status: ChangedFileStatus | null,
  original: string,
  modified: string
): string {
  if (status === 'deleted') {
    return original;
  }
  if (modified.length === 0 && original.length > 0) {
    return original;
  }
  return modified;
}

/**
 * The side to render read-only when `contentKind === 'text'` content is too
 * large to diff inline, or `null` when a normal MergeView/unifiedMergeView
 * diff should render instead. Extracted to a plain function (rather than an
 * inline expression in the component body) for the same cognitive-
 * complexity-budget reason as {@link resolveTruncatedNoteVisible} — and it
 * doubles as the single source of truth for "is this oversized", since
 * `oversizedDoc !== null` IS that boolean.
 */
function resolveOversizedDoc(
  contentKind: ResolvedDiffPresentation['kind'],
  textOriginal: string | null,
  textModified: string | null,
  status: ChangedFileStatus | null
): string | null {
  if (contentKind !== 'text' || textOriginal === null || textModified === null) {
    return null;
  }
  if (!isTextContentTooLargeToDiffInline(textOriginal, textModified)) {
    return null;
  }
  return pickOversizedDoc(status, textOriginal, textModified);
}

/**
 * Which oversize note the header should show, as one exhaustive value
 * instead of two overlapping booleans — `'sliced'` when the changed regions
 * ARE being shown, `'unsliceable'` for the honest "we could not locate the
 * changes" state, `'none'` when the content was never over threshold.
 * Extracted to a plain function for the same cognitive-complexity-budget
 * reason as {@link resolveTruncatedNoteVisible}.
 */
function resolveOversizeNote(
  oversizedDoc: string | null,
  sliced: SlicedTextDiff | null
): 'none' | 'sliced' | 'unsliceable' {
  if (sliced !== null) {
    return 'sliced';
  }
  return oversizedDoc === null ? 'none' : 'unsliceable';
}

/**
 * Whether the split/unified toggle applies. Only a REAL two-document diff
 * has a mode to switch: `hunks-only`/`binary` never mount one, and an
 * oversized `text` with no usable slice falls back to a single read-only
 * view. A SLICED diff is a real two-document diff and keeps the toggle.
 */
function resolveModeTogglable(
  contentKind: ResolvedDiffPresentation['kind'],
  oversizedDoc: string | null,
  sliced: SlicedTextDiff | null
): boolean {
  if (contentKind !== 'text') {
    return false;
  }
  return oversizedDoc === null || sliced !== null;
}

/**
 * The sliced document pair to diff when `text` content is over the
 * render-side thresholds, or `null` when the single read-only side is the
 * only honest thing left to show — either because there are no hunk ranges
 * to slice around (see {@link buildSlicedTextDiff}), or because the slice is
 * itself still too large.
 *
 * That second check is the one that keeps the guarantee: a file where nearly
 * every line changed slices to nearly itself, and handing THAT to
 * `MergeView` would reintroduce exactly the O(n·d) main-thread freeze the
 * thresholds exist to prevent. Extracted to a plain function (rather than an
 * inline `useMemo` body) for the same cognitive-complexity-budget reason as
 * {@link resolveTruncatedNoteVisible}.
 */
function resolveSlicedDiff(
  oversizedDoc: string | null,
  textOriginal: string | null,
  textModified: string | null,
  hunksKey: string
): SlicedTextDiff | null {
  if (oversizedDoc === null || textOriginal === null || textModified === null) {
    return null;
  }
  const candidate = buildSlicedTextDiff(textOriginal, textModified, hunksKey);
  if (candidate === null) {
    return null;
  }
  return isTextContentTooLargeToDiffInline(candidate.original, candidate.modified)
    ? null
    : candidate;
}

/**
 * A `lineNumbers()` gutter that reports each SLICED document line's absolute
 * file line instead of its position in the slice. This is the seam that lets
 * an over-threshold diff keep REAL line numbers: the slice drops whole
 * unchanged regions, so the vanilla gutter's 1..n counting would be wrong by
 * however many lines were elided above.
 */
function slicedLineNumbers(lineMap: readonly number[]): Extension {
  return lineNumbers({ formatNumber: createSlicedLineNumberFormatter(lineMap) });
}

/** What a `text`-kind build mounted, so the effect can track it for teardown. */
interface MountedTextDiff {
  readonly editorView: EditorView | null;
  readonly mergeView: MergeView | null;
}

/**
 * Mounts a real two-document diff over the SLICED pair — the same
 * `MergeView`/`unifiedMergeView` rendering as the under-threshold case, just
 * fed documents cut down to the changed regions, with absolute-line gutters
 * (see {@link slicedLineNumbers}).
 *
 * `collapseUnchanged` is deliberately omitted here: the slice has already
 * elided every unchanged region worth eliding, and collapsing again inside
 * an already-sliced view would stack two different "lines are hidden here"
 * affordances on top of each other.
 */
function mountSlicedDiff(params: {
  readonly host: HTMLElement;
  readonly languageExtension: Extension;
  readonly mode: DiffViewMode;
  readonly sliced: SlicedTextDiff;
}): MountedTextDiff {
  const { host, languageExtension, mode, sliced } = params;
  const originalExtensions: Extension[] = [
    slicedLineNumbers(sliced.originalLineMap),
    ...BASE_EXTENSIONS_NO_GUTTER,
    READ_ONLY_EXTENSIONS,
    languageExtension,
  ];
  const modifiedExtensions: Extension[] = [
    slicedLineNumbers(sliced.modifiedLineMap),
    ...BASE_EXTENSIONS_NO_GUTTER,
    READ_ONLY_EXTENSIONS,
    languageExtension,
  ];

  if (mode === 'split') {
    return {
      editorView: null,
      mergeView: new MergeView({
        a: { doc: sliced.original, extensions: originalExtensions },
        b: { doc: sliced.modified, extensions: modifiedExtensions },
        gutter: true,
        highlightChanges: true,
        orientation: 'a-b',
        parent: host,
      }),
    };
  }

  return {
    editorView: new EditorView({
      parent: host,
      state: EditorState.create({
        doc: sliced.modified,
        extensions: [
          ...modifiedExtensions,
          unifiedMergeView({
            gutter: true,
            mergeControls: false,
            original: sliced.original,
          }),
        ],
      }),
    }),
    mergeView: null,
  };
}

/**
 * Mounts the `text` presentation, in preference order: the sliced diff when
 * one could be built, else the single read-only side when the content is
 * over the render-side thresholds, else the normal whole-document
 * `MergeView`/`unifiedMergeView`. Extracted from the build effect's `switch`
 * so `buildWithLanguage` stays under Biome's cognitive-complexity limit.
 */
function mountTextDiff(params: {
  readonly host: HTMLElement;
  readonly languageExtension: Extension;
  readonly mode: DiffViewMode;
  readonly modified: string;
  readonly original: string;
  readonly oversizedDoc: string | null;
  readonly sliced: SlicedTextDiff | null;
}): MountedTextDiff {
  const { host, languageExtension, mode, modified, original, oversizedDoc, sliced } = params;

  if (sliced !== null) {
    return mountSlicedDiff({ host, languageExtension, mode, sliced });
  }

  if (oversizedDoc !== null) {
    // See RENDER_SIDE_SIZE_THRESHOLD_BYTES's doc comment: over threshold
    // with no sliceable hunk ranges (or a slice that is itself still too
    // large), skip the synchronous MergeView/unifiedMergeView diff entirely
    // and show one side read-only instead. Still gets real line numbers
    // (BASE_EXTENSIONS) and the file's language grammar — this IS the file's
    // actual content, just not diffed against the other side.
    return {
      editorView: new EditorView({
        parent: host,
        state: EditorState.create({
          doc: oversizedDoc,
          extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
        }),
      }),
      mergeView: null,
    };
  }

  if (mode === 'split') {
    return {
      editorView: null,
      mergeView: new MergeView({
        a: {
          doc: original,
          extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
        },
        b: {
          doc: modified,
          extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
        },
        collapseUnchanged: { margin: 3, minSize: 4 },
        gutter: true,
        highlightChanges: true,
        orientation: 'a-b',
        parent: host,
      }),
    };
  }

  return {
    editorView: new EditorView({
      parent: host,
      state: EditorState.create({
        doc: modified,
        extensions: [
          ...BASE_EXTENSIONS,
          READ_ONLY_EXTENSIONS,
          languageExtension,
          unifiedMergeView({
            collapseUnchanged: { margin: 3, minSize: 4 },
            gutter: true,
            // Read-only viewer: never show accept/reject chunk controls.
            mergeControls: false,
            original,
          }),
        ],
      }),
    }),
    mergeView: null,
  };
}

/**
 * Throws with `message` when `value` is `null`, narrowing it to `T`
 * afterward. The build effect's `contentKind`-gated branches use this to
 * assert the corresponding extracted scalar (`textOriginal`/`textModified`/
 * `hunkText`) is non-null — an invariant `extractTextDocs`/`extractHunkText`
 * already guarantee, restated here as a real check (never a silent
 * fallback) rather than a type-only assertion. A plain `if` per call site
 * would push `buildWithLanguage`'s cognitive-complexity score over Biome's
 * limit; this keeps each call site to one line.
 */
function assertNonNull<T>(value: T | null, message: string): asserts value is T {
  if (value === null) {
    throw new Error(message);
  }
}

/** User-facing labels for the structured-mode status chip. Exhaustive over `ChangedFileStatus`. */
const STATUS_LABELS: Record<ChangedFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

export type DiffViewMode = 'split' | 'unified';

interface DiffViewBaseProps {
  /** Accessible label for the diff region. */
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  /** Initial view mode. Defaults to `'split'` (side-by-side). */
  readonly defaultMode?: DiffViewMode | undefined;
  /** Filename used for syntax-highlighting language resolution (reused from CodeSurface). */
  readonly filename?: string | undefined;
  /** Explicit language name override (takes precedence over `filename`). */
  readonly language?: string | undefined;
  readonly testId?: string | undefined;
}

/**
 * Either a `source` (preferred) or both legacy `original`/`modified` string
 * props (plus optional `truncated`) — never neither, and never a mix. This
 * is enforced at compile time so a caller can't accidentally omit both; a
 * runtime throw in `resolveDiffView` remains the backstop for
 * anything that reaches the component past TypeScript (an untyped caller,
 * or a type escape).
 */
type DiffViewSourceProps =
  | {
      readonly modified?: undefined;
      readonly original?: undefined;
      readonly source: DiffViewSource;
      readonly truncated?: undefined;
    }
  | {
      /** "After" content (right / modified side). */
      readonly modified: string;
      /** "Before" content (left / original side). */
      readonly original: string;
      readonly source?: undefined;
      /** When true, render a "diff truncated" note (the IPC bounds large diffs). */
      readonly truncated?: boolean | undefined;
    };

export type DiffViewProps = DiffViewBaseProps & DiffViewSourceProps;

/**
 * Reusable, read-only diff viewer built on `@codemirror/merge`.
 *
 * - `split` mode renders a side-by-side {@link MergeView} (original | modified).
 * - `unified` mode renders a single editor with {@link unifiedMergeView}
 *   (inline additions/deletions).
 *
 * Both modes reuse {@link resolveCodeSurfaceLanguage} (the same path→language
 * mapping as `CodeSurface`) for syntax highlighting, and the same theme tokens,
 * so the diff matches the rest of the app's code surfaces. The view is strictly
 * read-only — there is no editing or chunk reverting in this component (it will
 * be reused by the edit-approval flow later, which adds its own controls).
 */
export function DiffView({
  ariaLabel = 'Diff viewer',
  className,
  defaultMode = 'split',
  filename,
  language,
  original,
  modified,
  source,
  truncated,
  testId,
}: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<DiffViewMode>(defaultMode);

  // Cheap to recompute every render (a switch + a handful of field reads) —
  // deliberately NOT memoized against `source`'s object identity, since a
  // caller re-rendering with a freshly-allocated `source={{kind:'structured',
  // diff}}` literal every render (the W4 multi-file-surface pattern) is the
  // exact case this needs to handle correctly, not optimize away. The
  // identity-stability guarantee lives in the SCALAR fields below
  // (`textOriginal`/`textModified`/`hunkText`), not in `resolved`/
  // `presentation` themselves — see the build effect's dependency comment.
  const resolved = resolveDiffView({ modified, original, source, truncated });
  const { presentation } = resolved;
  const effectiveFilename = filename ?? resolved.filenameFallback;

  // Memoized on the underlying primitives (`language`, `effectiveFilename` —
  // both strings), NOT recomputed as a fresh object every render: this keeps
  // `resolvedLanguage`'s object identity stable when neither actually
  // changes, which the build effect below relies on (see its dependency-
  // array comment — the same object-identity-vs-value-identity trap that
  // motivates depending on the scalar `textOriginal`/`textModified`/
  // `hunkText` fields instead of `presentation` itself, just for a
  // different input).
  const resolvedLanguage = useMemo(
    () => resolveCodeSurfaceLanguage({ language, path: effectiveFilename }),
    [language, effectiveFilename]
  );

  const truncatedNoteVisible = resolveTruncatedNoteVisible(presentation);

  // Scalar extractions the build effect depends on — plain values, so two
  // renders with EQUAL content compare equal here via Object.is regardless
  // of `source`/`presentation` object identity (the reference/value-
  // equality fast path). `null`/not-applicable fields stay `null` for the
  // current `presentation.kind`. The effect below reads ONLY these
  // variables (never `presentation`/`resolved` themselves), so its
  // dependency array is honest — every value the effect body touches is
  // listed, and nothing it touches is missing.
  const contentKind = presentation.kind;
  const { modified: textModified, original: textOriginal } = extractTextDocs(presentation);
  const hunkText = extractHunkText(presentation);
  // Non-null exactly when `text` content is over the render-side
  // interactivity thresholds — see `resolveOversizedDoc`'s doc comment.
  // `resolved.status` is read here (component scope), NOT inside the
  // effect, matching the same discipline as the other scalar extractions.
  const oversizedDoc = resolveOversizedDoc(
    contentKind,
    textOriginal,
    textModified,
    resolved.status
  );

  // Non-null when an over-threshold `text` pair could be cut down to just
  // its changed regions AND that slice is itself small enough to diff
  // interactively.
  //
  // Computed inline rather than in a `useMemo`, and used ONLY for the header
  // note and the mode toggle below — the build effect deliberately calls
  // `resolveSlicedDiff` again with the same scalars rather than closing over
  // this object. Two reasons, and they point the same way:
  //
  //   1. Effect-dependency discipline. Every dependency of the build effect
  //      is a scalar so that a caller re-rendering with a freshly-allocated
  //      `source` literal carrying equal content does not tear down and
  //      rebuild CodeMirror. A sliced-diff OBJECT in that array would be a
  //      fresh identity every render and reintroduce exactly that bug; only
  //      a `useMemo` could have made it stable.
  //   2. That `useMemo` is precisely what React Compiler refuses to preserve
  //      (`react-hooks/preserve-manual-memoization`). All four of its
  //      dependencies trace back through `extractTextDocs`/`resolveDiffView`
  //      to one object the compiler cannot prove is never mutated, so it
  //      bails on optimizing the whole component rather than keeping the
  //      memo — the same bail the pre-existing `resolvedLanguage` memo
  //      takes on `effectiveFilename`.
  //
  // `resolveSlicedDiff` is pure, so the render's answer and the effect's are
  // necessarily the same: the note can never claim a sliced view the effect
  // did not mount. Do not "optimize" one side into reusing the other's
  // object — that is what puts an unstable identity back in the array.
  const { hunksKey } = resolved;
  const slicedDiff = resolveSlicedDiff(oversizedDoc, textOriginal, textModified, hunksKey);

  const modeTogglable = resolveModeTogglable(contentKind, oversizedDoc, slicedDiff);
  const oversizeNote = resolveOversizeNote(oversizedDoc, slicedDiff);

  // Only mode/language/content-KIND drive a full `<section>` remount —
  // content CHANGES within the same kind (including crossing the oversized
  // threshold) are handled by the build effect's own teardown/rebuild (via
  // `textOriginal`/`textModified`/`hunkText`/`oversizedDoc` above) without
  // needing to blow away the host DOM node.
  const renderKey = `${mode}:${resolvedLanguage.label}:${contentKind}`;

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'split' ? 'unified' : 'split'));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let mergeView: MergeView | null = null;
    let editorView: EditorView | null = null;

    const buildWithLanguage = (languageSupport: LanguageSupport | null): void => {
      if (disposed || hostRef.current !== host) {
        return;
      }
      const languageExtension: Extension = languageSupport ?? [];

      switch (contentKind) {
        case 'binary':
          return;
        case 'hunks-only': {
          // Invariant: `extractHunkText` returns non-null exactly when
          // `contentKind === 'hunks-only'`, which this case is gated on.
          assertNonNull(hunkText, 'DiffView: hunks-only content resolved with no hunkText.');
          // No file-language grammar over raw diff text (see
          // `buildHunkLineDecorations`'s doc comment), and no `lineNumbers()`
          // gutter (see `BASE_EXTENSIONS`'s doc comment) — `languageSupport`
          // is intentionally unused on this branch.
          editorView = new EditorView({
            parent: host,
            state: EditorState.create({
              doc: hunkText,
              extensions: [
                ...BASE_EXTENSIONS_NO_GUTTER,
                READ_ONLY_EXTENSIONS,
                buildHunkLineDecorations(hunkText),
              ],
            }),
          });
          return;
        }
        case 'text': {
          // Invariant: `extractTextDocs` returns non-null fields exactly
          // when `contentKind === 'text'`, which this case is gated on.
          assertNonNull(textOriginal, 'DiffView: text content resolved with no original.');
          assertNonNull(textModified, 'DiffView: text content resolved with no modified.');

          const mounted = mountTextDiff({
            host,
            languageExtension,
            mode,
            modified: textModified,
            original: textOriginal,
            oversizedDoc,
            // Rebuilt from the same scalars the render used, rather than
            // closed over from the render — see `slicedDiff`'s comment for
            // why this effect's dependency array admits scalars only.
            sliced: resolveSlicedDiff(oversizedDoc, textOriginal, textModified, hunksKey),
          });
          mergeView = mounted.mergeView;
          editorView = mounted.editorView;
          return;
        }
        default: {
          const exhaustive: never = contentKind;
          throw new Error(`Unhandled diff presentation kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    };

    // Build immediately with plaintext, then upgrade once async language support
    // resolves — mirrors CodeSurface's progressive-highlight behavior so the diff
    // is visible instantly and never blocks on a dynamic import. Skipped entirely
    // for `hunks-only`/`binary`, which never use a language extension.
    buildWithLanguage(null);

    if (contentKind === 'text' && resolvedLanguage.loadSupport) {
      void resolvedLanguage
        .loadSupport()
        .then((support) => {
          if (disposed || !support || hostRef.current !== host) {
            return;
          }
          // Re-build with the loaded language. Tear the plaintext view down first.
          mergeView?.destroy();
          editorView?.destroy();
          mergeView = null;
          editorView = null;
          buildWithLanguage(support);
        })
        .catch((error: unknown) => {
          logger.debug('Failed to load diff language support; keeping plaintext fallback', {
            error,
            language: resolvedLanguage.label,
          });
        });
    }

    return () => {
      disposed = true;
      mergeView?.destroy();
      editorView?.destroy();
    };
    // Deliberately depends on the SCALAR content fields (`contentKind`,
    // `textOriginal`, `textModified`, `hunkText`, `oversizedDoc`) plus
    // `mode`/`resolvedLanguage` — never on `resolved`/`presentation`/
    // `source` object identity, and the effect body above reads ONLY these
    // same scalars (never `presentation` itself), so every dependency this
    // effect actually uses is listed here — an honest, exhaustive-deps-
    // clean array, not a suppressed warning. `oversizedDoc` is technically
    // derivable from `textOriginal`/`textModified`/`contentKind` (already
    // listed), but the effect body reads `oversizedDoc` directly, so it's
    // listed too — redundant-but-consistent beats implicit. `hunksKey` is
    // the serialized stand-in for the identity-unstable `hunks` array (see
    // its doc comment); the effect body slices with it rather than closing
    // over a sliced-diff object, keeping every entry here a scalar.
    // Plain strings compare by value (`Object.is` on two equal strings is
    // `true` regardless of which object they came from), so a caller
    // re-rendering with a freshly-allocated `source` object literal
    // carrying THE SAME content — exactly what W4's multi-file surface does
    // — does not rebuild CodeMirror. Depending on the `presentation`/
    // `resolved` OBJECT directly here was the original bug: it rebuilds
    // (losing scroll/selection/collapsed-hunk state, re-running async
    // language load) on every unrelated parent render, since `presentation`
    // is a fresh object every time even when its fields are unchanged.
  }, [
    contentKind,
    textOriginal,
    textModified,
    hunkText,
    oversizedDoc,
    hunksKey,
    mode,
    resolvedLanguage,
  ]);

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background text-foreground', className)}
      data-language={resolvedLanguage.label}
      data-mode={modeTogglable ? mode : undefined}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2 border-border border-b px-2 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-muted-foreground text-xs">
            {effectiveFilename ?? 'Diff'}
          </span>
          {resolved.status ? (
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
              data-testid="diff-status-chip"
            >
              {STATUS_LABELS[resolved.status]}
            </span>
          ) : null}
          {resolved.statSummary ? (
            <span className="text-muted-foreground text-xs" data-testid="diff-stat-summary">
              <span aria-hidden="true">
                +{resolved.statSummary.additions} −{resolved.statSummary.deletions}
              </span>
              <span className="sr-only">
                {resolved.statSummary.additions}{' '}
                {resolved.statSummary.additions === 1 ? 'addition' : 'additions'},{' '}
                {resolved.statSummary.deletions}{' '}
                {resolved.statSummary.deletions === 1 ? 'deletion' : 'deletions'}
              </span>
            </span>
          ) : null}
          {/* Tint is deliberately raw amber-500/15, not bg-warning/15: the
              warning token is a deep amber that darkens the surface toward the
              text, so text-warning composites to 4.64:1 here but 4.24:1 on
              bg-warning/15. Re-measure these badges if --bs-warning is retuned. */}
          {presentation.kind === 'hunks-only' ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-warning text-xs"
              data-testid="diff-over-cap-note"
            >
              {presentation.sideNote}
            </span>
          ) : null}
          {oversizeNote === 'sliced' ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-warning text-xs"
              data-testid="diff-sliced-note"
            >
              File too large to diff in full — showing changed regions with surrounding context
            </span>
          ) : null}
          {/* Shown only when there was no usable slice — the honest "we
              cannot locate the changes" state (no hunk ranges, or a slice
              still too large to diff interactively), never a
              silently-degraded stand-in for the sliced view. */}
          {oversizeNote === 'unsliceable' ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-warning text-xs"
              data-testid="diff-too-large-note"
            >
              File too large to diff inline — showing content without change highlighting
            </span>
          ) : null}
          {truncatedNoteVisible ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-warning text-xs"
              data-testid="diff-truncated-note"
            >
              diff truncated
            </span>
          ) : null}
        </div>
        {modeTogglable ? (
          <Button
            aria-label={mode === 'split' ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
            aria-pressed={mode === 'unified'}
            onClick={toggleMode}
            size="xs"
            type="button"
            variant="outline"
          >
            {mode === 'split' ? 'Inline' : 'Side by side'}
          </Button>
        ) : null}
      </div>
      {/* The CodeMirror MergeView / EditorView is imperatively mounted here for
          `text`/`hunks-only` content. The labelled region groups the diff
          content for assistive tech — always this `<section>`, even for
          `binary`, so there's exactly one accessible name for the whole diff
          area. The binary placeholder is a PLAIN div: giving it its own
          `aria-label` would override its own visible text as the accessible
          name (an element with `aria-label` ignores its text content for
          that computation), and `role="status"` would wrongly turn static
          content into a live region. */}
      <section
        aria-label={ariaLabel}
        className="min-h-0 flex-1 overflow-hidden"
        key={renderKey}
        ref={hostRef}
      >
        {presentation.kind === 'binary' ? (
          <div
            className="flex h-full min-h-0 items-center justify-center text-muted-foreground text-sm"
            data-testid="diff-binary-note"
          >
            Binary file — no text diff
          </div>
        ) : null}
      </section>
    </div>
  );
}
