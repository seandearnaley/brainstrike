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
import { type DiffViewSource, resolveDiffPresentation } from './diff-view-source';

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
  for (const line of hunkText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      builder.add(pos, pos, Decoration.line({ class: 'cm-insertedLine' }));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      builder.add(pos, pos, Decoration.line({ class: 'cm-deletedChunk' }));
    }
    pos += line.length + 1;
  }
  return EditorView.decorations.of(builder.finish());
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
 * runtime throw in `resolveDiffPresentation` remains the backstop for
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

  // Cheap to recompute every render (a switch + a couple of string
  // concatenations) — deliberately NOT memoized against `source`'s object
  // identity, since a caller re-rendering with a freshly-allocated
  // `source={{kind:'structured', diff}}` literal every render (the W4
  // multi-file-surface pattern) is the exact case this needs to handle
  // correctly, not optimize away. See `resolved.cacheKey`'s doc comment for
  // where the actual identity-stability guarantee lives.
  const resolved = resolveDiffPresentation({ modified, original, source, truncated });
  const { presentation } = resolved;
  const effectiveFilename = filename ?? resolved.filenameFallback;

  // Memoized on the underlying primitives (`language`, `effectiveFilename` —
  // both strings), NOT recomputed as a fresh object every render: this keeps
  // `resolvedLanguage`'s object identity stable when neither actually
  // changes, which the build effect below relies on (see its dependency-
  // array comment — the same object-identity-vs-value-identity trap that
  // motivated `resolved.cacheKey`, just for a different input).
  const resolvedLanguage = useMemo(
    () => resolveCodeSurfaceLanguage({ language, path: effectiveFilename }),
    [language, effectiveFilename]
  );

  // Split/unified toggling only applies when there are two documents to
  // compare — `hunks-only` is a single bounded text and `binary` mounts
  // nothing, so neither has a mode to switch.
  const modeTogglable = presentation.kind === 'text';
  const truncatedNoteVisible =
    presentation.kind === 'text'
      ? presentation.truncated
      : presentation.kind === 'hunks-only' && presentation.hunkTextTruncated;

  // Folds in the actual content identity (`resolved.cacheKey`, NOT the
  // `source`/`presentation` object reference — see its doc comment) + mode +
  // resolved language, so the `<section key={renderKey}>` below — and the
  // build effect, which depends on this alone — only remounts/rebuilds when
  // something semantically relevant changes.
  const renderKey = `${mode}:${resolvedLanguage.label}:${resolved.cacheKey}`;

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'split' ? 'unified' : 'split'));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    // `binary` renders no `<section>` (see JSX below), so `host` is already
    // null in that case — nothing further to guard here.
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

      switch (presentation.kind) {
        case 'binary':
          return;
        case 'hunks-only': {
          // No file-language grammar over raw diff text (see
          // `buildHunkLineDecorations`'s doc comment), and no `lineNumbers()`
          // gutter (see `BASE_EXTENSIONS`'s doc comment) — `languageSupport`
          // is intentionally unused on this branch.
          editorView = new EditorView({
            parent: host,
            state: EditorState.create({
              doc: presentation.hunkText,
              extensions: [
                ...BASE_EXTENSIONS_NO_GUTTER,
                READ_ONLY_EXTENSIONS,
                buildHunkLineDecorations(presentation.hunkText),
              ],
            }),
          });
          return;
        }
        case 'text': {
          const { original: originalDoc, modified: modifiedDoc } = presentation;

          if (mode === 'split') {
            mergeView = new MergeView({
              a: {
                doc: originalDoc,
                extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
              },
              b: {
                doc: modifiedDoc,
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
              doc: modifiedDoc,
              extensions: [
                ...BASE_EXTENSIONS,
                READ_ONLY_EXTENSIONS,
                languageExtension,
                unifiedMergeView({
                  collapseUnchanged: { margin: 3, minSize: 4 },
                  gutter: true,
                  // Read-only viewer: never show accept/reject chunk controls.
                  mergeControls: false,
                  original: originalDoc,
                }),
              ],
            }),
          });
          return;
        }
        default: {
          const exhaustive: never = presentation;
          throw new Error(`Unhandled diff presentation kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    };

    // Build immediately with plaintext, then upgrade once async language support
    // resolves — mirrors CodeSurface's progressive-highlight behavior so the diff
    // is visible instantly and never blocks on a dynamic import. Skipped entirely
    // for `hunks-only`/`binary`, which never use a language extension.
    buildWithLanguage(null);

    if (presentation.kind === 'text' && resolvedLanguage.loadSupport) {
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
    // Deliberately depends on `renderKey`/`mode`/`resolvedLanguage` ONLY —
    // never on `resolved`/`presentation`/`source` object identity. Two
    // renders with equal `renderKey` are GUARANTEED to carry equal actual
    // content (that's what `resolved.cacheKey` encodes), so reusing the
    // `presentation` closure captured on the render that last changed
    // `renderKey` is correct even though `presentation` itself is a fresh
    // object every render. Depending on `presentation` directly here was
    // the bug: it rebuilds CodeMirror (losing scroll/selection/collapsed-
    // hunk state, re-running async language load) on every parent render
    // that passes a freshly-allocated `source` object literal with THE SAME
    // content — exactly what W4's multi-file surface does.
  }, [renderKey, mode, resolvedLanguage]);

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
      {presentation.kind === 'binary' ? (
        <div
          aria-label={ariaLabel}
          className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm"
          data-testid="diff-binary-note"
          role="status"
        >
          Binary file — no text diff
        </div>
      ) : (
        // The CodeMirror MergeView / EditorView is imperatively mounted here. The
        // labelled region groups the diff content for assistive tech.
        <section
          aria-label={ariaLabel}
          className="min-h-0 flex-1 overflow-hidden"
          key={renderKey}
          ref={hostRef}
        />
      )}
    </div>
  );
}
