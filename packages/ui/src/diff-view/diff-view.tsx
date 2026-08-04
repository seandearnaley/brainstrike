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
 * Extensions shared by every editor EXCEPT the hunks-only view — no
 * `lineNumbers()` gutter here (see {@link BASE_EXTENSIONS}'s doc comment).
 */
const BASE_EXTENSIONS_NO_GUTTER: Extension[] = [
  highlightSpecialChars(),
  drawSelection(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.lineWrapping,
  DIFF_THEME,
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

  // Split/unified toggling only applies when there are two documents to
  // compare — `hunks-only` is a single bounded text and `binary` mounts
  // nothing, so neither has a mode to switch.
  const modeTogglable = presentation.kind === 'text';
  const truncatedNoteVisible = resolveTruncatedNoteVisible(presentation);

  // Scalar extractions the build effect depends on — plain values, so two
  // renders with EQUAL content compare equal here via Object.is regardless
  // of `source`/`presentation` object identity (the reference/value-
  // equality fast path). `null`/not-applicable fields stay `null` for the
  // current `presentation.kind`. The effect below reads ONLY these four
  // variables (never `presentation`/`resolved` themselves), so its
  // dependency array is honest — every value the effect body touches is
  // listed, and nothing it touches is missing.
  const contentKind = presentation.kind;
  const { modified: textModified, original: textOriginal } = extractTextDocs(presentation);
  const hunkText = extractHunkText(presentation);

  // Only mode/language/content-KIND drive a full `<section>` remount —
  // content CHANGES within the same kind are handled by the build effect's
  // own teardown/rebuild (via `textOriginal`/`textModified`/`hunkText`
  // above) without needing to blow away the host DOM node.
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

          if (mode === 'split') {
            mergeView = new MergeView({
              a: {
                doc: textOriginal,
                extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
              },
              b: {
                doc: textModified,
                extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
              },
              collapseUnchanged: { margin: 3, minSize: 4 },
              gutter: true,
              highlightChanges: true,
              orientation: 'a-b',
              parent: host,
            });
            return;
          }

          editorView = new EditorView({
            parent: host,
            state: EditorState.create({
              doc: textModified,
              extensions: [
                ...BASE_EXTENSIONS,
                READ_ONLY_EXTENSIONS,
                languageExtension,
                unifiedMergeView({
                  collapseUnchanged: { margin: 3, minSize: 4 },
                  gutter: true,
                  // Read-only viewer: never show accept/reject chunk controls.
                  mergeControls: false,
                  original: textOriginal,
                }),
              ],
            }),
          });
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
    // `textOriginal`, `textModified`, `hunkText`) plus `mode`/`resolvedLanguage`
    // — never on `resolved`/`presentation`/`source` object identity, and the
    // effect body above reads ONLY these same scalars (never `presentation`
    // itself), so every dependency this effect actually uses is listed here
    // — an honest, exhaustive-deps-clean array, not a suppressed warning.
    // Plain strings compare by value (`Object.is` on two equal strings is
    // `true` regardless of which object they came from), so a caller
    // re-rendering with a freshly-allocated `source` object literal
    // carrying THE SAME content — exactly what W4's multi-file surface does
    // — does not rebuild CodeMirror. Depending on the `presentation`/
    // `resolved` OBJECT directly here was the original bug: it rebuilds
    // (losing scroll/selection/collapsed-hunk state, re-running async
    // language load) on every unrelated parent render, since `presentation`
    // is a fresh object every time even when its fields are unchanged.
  }, [contentKind, textOriginal, textModified, hunkText, mode, resolvedLanguage]);

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background text-foreground', className)}
      data-language={resolvedLanguage.label}
      data-mode={presentation.kind === 'text' ? mode : undefined}
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
          {presentation.kind === 'hunks-only' ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 text-xs dark:text-amber-400"
              data-testid="diff-over-cap-note"
            >
              {presentation.sideNote}
            </span>
          ) : null}
          {truncatedNoteVisible ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 text-xs dark:text-amber-400"
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
