import { createLogger } from '@brainstrike/logging';
import {
  defaultHighlightStyle,
  type LanguageSupport,
  syntaxHighlighting,
} from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
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

const BASE_EXTENSIONS: Extension[] = [
  highlightSpecialChars(),
  lineNumbers(),
  drawSelection(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.lineWrapping,
  DIFF_THEME,
];

export type DiffViewMode = 'split' | 'unified';

export interface DiffViewProps {
  /** Accessible label for the diff region. */
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  /** Initial view mode. Defaults to `'split'` (side-by-side). */
  readonly defaultMode?: DiffViewMode | undefined;
  /** Filename used for syntax-highlighting language resolution (reused from CodeSurface). */
  readonly filename?: string | undefined;
  /** Explicit language name override (takes precedence over `filename`). */
  readonly language?: string | undefined;
  /** "After" content (right / modified side). Legacy; ignored when `source` is given. */
  readonly modified?: string | undefined;
  /** "Before" content (left / original side). Legacy; ignored when `source` is given. */
  readonly original?: string | undefined;
  /**
   * Preferred content source. Takes precedence over `original`/`modified`/
   * `truncated` when present. Neither `source` nor the legacy string props
   * being given is a contract violation — `DiffView` throws rather than
   * rendering blank.
   */
  readonly source?: DiffViewSource | undefined;
  readonly testId?: string | undefined;
  /**
   * When true, render a "diff truncated" note (the IPC bounds large diffs).
   * Legacy; ignored when `source` is given (structured `hunks-only` content
   * drives the same note via `hunkTextTruncated`).
   */
  readonly truncated?: boolean | undefined;
}

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

  const resolvedLanguage = useMemo(
    () => resolveCodeSurfaceLanguage({ language, path: filename }),
    [language, filename]
  );

  const presentation = useMemo(
    () => resolveDiffPresentation({ modified, original, source, truncated }),
    [modified, original, source, truncated]
  );
  // Split/unified toggling only applies when there are two documents to
  // compare — `hunks-only` is a single bounded text and `binary` mounts
  // nothing, so neither has a mode to switch.
  const modeTogglable = presentation.kind === 'text';
  const truncatedNoteVisible =
    presentation.kind === 'text'
      ? presentation.truncated
      : presentation.kind === 'hunks-only' && presentation.hunkTextTruncated;
  const statSummary =
    source?.kind === 'structured' &&
    source.diff.additions !== null &&
    source.diff.deletions !== null
      ? { additions: source.diff.additions, deletions: source.diff.deletions }
      : null;

  // Re-mount the CodeMirror view whenever the inputs that affect its construction
  // change. `@codemirror/merge`'s MergeView has no simple "swap docs" API for a
  // read-only view, so a clean teardown/rebuild is the simplest correct approach
  // (the documents here are bounded diffs, not whole large files). A plain string
  // concat is cheap — no useMemo needed. Folds in the source/content kind so a
  // strings↔structured or full↔hunks-only↔binary transition rebuilds cleanly too.
  const sourceKind = source?.kind ?? 'strings';
  const contentKind = source?.kind === 'structured' ? source.diff.content.kind : 'text';
  const renderKey = `${mode}:${resolvedLanguage.label}:${sourceKind}:${contentKind}`;

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
          editorView = new EditorView({
            parent: host,
            state: EditorState.create({
              doc: presentation.hunkText,
              extensions: [...BASE_EXTENSIONS, READ_ONLY_EXTENSIONS, languageExtension],
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
    // is visible instantly and never blocks on a dynamic import.
    buildWithLanguage(null);

    if (resolvedLanguage.loadSupport) {
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
    // `renderKey` is intentionally a dependency: it folds `mode` +
    // `resolvedLanguage.label` + source/content kind so any of those
    // transitions rebuild the view.
  }, [renderKey, presentation, mode, resolvedLanguage]);

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background text-foreground', className)}
      data-language={resolvedLanguage.label}
      data-mode={mode}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2 border-border border-b px-2 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-muted-foreground text-xs">{filename ?? 'Diff'}</span>
          {statSummary ? (
            <span className="text-muted-foreground text-xs" data-testid="diff-stat-summary">
              +{statSummary.additions} −{statSummary.deletions}
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
          className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm"
          data-testid="diff-binary-note"
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
