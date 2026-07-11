import { createLogger } from '@brainstrike/utils/logger';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/utils';
import { type CodeSurfaceLanguageResolution, resolveCodeSurfaceLanguage } from './language';

export interface CodeSurfaceSelection {
  readonly from: number;
  readonly to: number;
}

export interface CodeSurfaceContextMenuSelection extends CodeSurfaceSelection {
  /** Exact editor text at invocation time; null when the selection is collapsed. */
  readonly text: string | null;
}

export interface CodeSurfaceProps {
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  readonly editable?: boolean | undefined;
  /**
   * 1-based line to scroll into view on first content render (e.g. a
   * search-match target). When provided it WINS over {@link initialScrollTop}
   * (see the mount effect) — line targeting is an explicit intent that
   * supersedes restored scroll position. First-render only, like initialScrollTop.
   */
  readonly initialLine?: number | undefined;
  readonly initialScrollTop?: number | undefined;
  /**
   * Inclusive, 1-based line range to select on first content render (e.g. a
   * search chunk the user opened so the block is highlighted and ready to copy).
   * When provided it WINS over {@link initialLine} and {@link initialScrollTop}
   * and implies the scroll (the range is scrolled into view — no double-scroll).
   * The editor is read-only, but CodeMirror still renders and lets the user copy
   * the selection. First-render only, like initialLine.
   */
  readonly initialSelection?: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly language?: string | undefined;
  readonly lineWrapping?: boolean | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  /** Synchronous semantic selection snapshot taken from EditorView on `contextmenu`. */
  readonly onContextMenuSelection?:
    | ((selection: CodeSurfaceContextMenuSelection) => void)
    | undefined;
  readonly onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  readonly onSelectionChange?: ((selection: CodeSurfaceSelection) => void) | undefined;
  readonly path?: string | undefined;
  readonly testId?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly value: string;
}

interface CodeSurfaceCallbacks {
  readonly onChange: ((value: string) => void) | undefined;
  readonly onContextMenuSelection:
    | ((selection: CodeSurfaceContextMenuSelection) => void)
    | undefined;
  readonly onScrollTopChange: ((scrollTop: number) => void) | undefined;
  readonly onSelectionChange: ((selection: CodeSurfaceSelection) => void) | undefined;
}

const MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const logger = createLogger('CodeSurface');
const externalValueSyncAnnotation = Annotation.define<boolean>();

const BASE_EXTENSIONS: Extension[] = [
  highlightSpecialChars(),
  lineNumbers(),
  highlightActiveLineGutter(),
  drawSelection(),
  rectangularSelection(),
  highlightActiveLine(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.theme({
    '.cm-content': {
      caretColor: 'hsl(var(--foreground))',
      fontFamily: MONO_FONT_FAMILY,
      fontSize: '0.8125rem',
      lineHeight: '1.55',
      minHeight: '100%',
      padding: '0.75rem 0',
    },
    '.cm-editor': {
      height: '100%',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-gutter': {
      backgroundColor: 'hsl(var(--muted) / 0.35)',
    },
    '.cm-gutters': {
      backgroundColor: 'hsl(var(--muted) / 0.35)',
      borderRight: '1px solid hsl(var(--border))',
      color: 'hsl(var(--muted-foreground))',
    },
    '.cm-line': {
      padding: '0 1rem',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '3rem',
      padding: '0 0.75rem 0 0.5rem',
    },
    '.cm-scroller': {
      fontFamily: MONO_FONT_FAMILY,
      overflow: 'auto',
    },
    '.cm-selectionBackground': {
      // CodeMirror injects selection styles with high specificity; keep app theme contrast.
      backgroundColor: 'hsl(var(--primary) / 0.2) !important',
    },
    '&': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
      height: '100%',
      minHeight: '100%',
    },
  }),
];

export function CodeSurface({
  ariaLabel = 'Code viewer',
  className,
  editable = false,
  initialLine,
  initialSelection,
  initialScrollTop = 0,
  language,
  lineWrapping = false,
  onChange,
  onContextMenuSelection,
  onScrollTopChange,
  onSelectionChange,
  path,
  testId,
  truncated = false,
  value,
}: CodeSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());
  const wrappingCompartmentRef = useRef(new Compartment());
  const contentAttributesCompartmentRef = useRef(new Compartment());
  const callbacksRef = useRef<CodeSurfaceCallbacks>({
    onChange,
    onContextMenuSelection,
    onScrollTopChange,
    onSelectionChange,
  });
  const initialConfigRef = useRef({
    ariaLabel,
    editable,
    initialLine,
    initialScrollTop,
    initialSelection,
    lineWrapping,
    value,
  });

  const resolvedLanguage = useMemo<CodeSurfaceLanguageResolution>(
    () => resolveCodeSurfaceLanguage({ language, path }),
    [language, path]
  );

  useEffect(() => {
    callbacksRef.current = {
      onChange,
      onContextMenuSelection,
      onScrollTopChange,
      onSelectionChange,
    };
  }, [onChange, onContextMenuSelection, onScrollTopChange, onSelectionChange]);

  useEffect(() => {
    // EditorView is intentionally created once; prop updates are handled by sync effects below.
    const initialConfig = initialConfigRef.current;
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialConfig.value,
        extensions: [
          ...BASE_EXTENSIONS,
          wrappingCompartmentRef.current.of(
            initialConfig.lineWrapping ? EditorView.lineWrapping : []
          ),
          editableCompartmentRef.current.of(createEditableExtensions(initialConfig.editable)),
          contentAttributesCompartmentRef.current.of(
            createContentAttributes(initialConfig.ariaLabel)
          ),
          languageCompartmentRef.current.of([]),
          EditorView.updateListener.of((update) => {
            const isExternalValueSync = update.transactions.some(
              (transaction) => transaction.annotation(externalValueSyncAnnotation) === true
            );
            if (update.docChanged && !isExternalValueSync) {
              callbacksRef.current.onChange?.(update.state.doc.toString());
            }
            if (update.selectionSet) {
              const range = update.state.selection.main;
              callbacksRef.current.onSelectionChange?.({
                from: range.from,
                to: range.to,
              });
            }
          }),
          EditorView.domEventHandlers({
            contextmenu: (_event, editorView) => {
              const range = editorView.state.selection.main;
              callbacksRef.current.onContextMenuSelection?.({
                from: range.from,
                text:
                  range.from === range.to
                    ? null
                    : editorView.state.doc.sliceString(range.from, range.to),
                to: range.to,
              });
              // Claiming context is observational. Radix/the browser still owns
              // whether the event opens a menu, so do not prevent it here.
              return false;
            },
          }),
        ],
      }),
    });

    const handleScroll = () => {
      callbacksRef.current.onScrollTopChange?.(view.scrollDOM.scrollTop);
    };

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    viewRef.current = view;
    const restoreScrollFrame = window.requestAnimationFrame(() => {
      if (viewRef.current !== view) {
        return;
      }
      // Precedence (all first-render only): an explicit `initialSelection`
      // (chunk-targeted open) wins over `initialLine` (line-targeted open, e.g.
      // a workspace-search match), which wins over `initialScrollTop` (restored
      // scroll position). Each applies only when provided, so ordinary
      // reopen-restore is unaffected.
      const targetSelection = initialConfig.initialSelection;
      if (targetSelection) {
        const lineCount = view.state.doc.lines;
        const startLine = Math.min(Math.max(1, Math.floor(targetSelection.startLine)), lineCount);
        const endLine = Math.min(
          Math.max(startLine, Math.floor(targetSelection.endLine)),
          lineCount
        );
        const fromPos = view.state.doc.line(startLine).from;
        const toPos = view.state.doc.line(endLine).to;
        // Read-only editors still allow (and render) a selection, so the user can
        // copy the block immediately. The selection scroll target replaces the
        // line/scroll paths above (initialSelection implies the scroll).
        view.dispatch({
          effects: EditorView.scrollIntoView(fromPos, { y: 'center' }),
          selection: EditorSelection.range(fromPos, toPos),
        });
        return;
      }
      const targetLine = initialConfig.initialLine;
      if (typeof targetLine === 'number' && targetLine > 0) {
        const lineCount = view.state.doc.lines;
        const clampedLine = Math.min(Math.max(1, Math.floor(targetLine)), lineCount);
        const linePos = view.state.doc.line(clampedLine).from;
        view.dispatch({ effects: EditorView.scrollIntoView(linePos, { y: 'center' }) });
        return;
      }
      view.scrollDOM.scrollTop = Math.max(0, initialConfig.initialScrollTop);
    });

    return () => {
      window.cancelAnimationFrame(restoreScrollFrame);
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }
    view.dispatch({
      annotations: externalValueSyncAnnotation.of(true),
      changes: {
        from: 0,
        insert: value,
        to: currentValue.length,
      },
      selection: EditorSelection.cursor(0),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(createEditableExtensions(editable)),
    });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: wrappingCompartmentRef.current.reconfigure(
        lineWrapping ? EditorView.lineWrapping : []
      ),
    });
  }, [lineWrapping]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: contentAttributesCompartmentRef.current.reconfigure(
        createContentAttributes(ariaLabel)
      ),
    });
  }, [ariaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    let cancelled = false;

    if (!resolvedLanguage.loadSupport) {
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure([]),
      });
      return;
    }

    void resolvedLanguage
      .loadSupport()
      .then((support) => {
        if (cancelled || viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: languageCompartmentRef.current.reconfigure(support ?? []),
        });
      })
      .catch((error: unknown) => {
        logger.debug('Failed to load CodeMirror language support; keeping plaintext fallback', {
          error,
          language: resolvedLanguage.label,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedLanguage]);

  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-hidden border-border border-t bg-background text-foreground',
        className
      )}
      data-editable={editable ? 'true' : 'false'}
      data-language={resolvedLanguage.label}
      data-testid={testId}
      data-truncated={truncated ? 'true' : 'false'}
    >
      <div className="h-full min-h-0" ref={hostRef} />
    </div>
  );
}

function createEditableExtensions(editable: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

function createContentAttributes(ariaLabel: string): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': ariaLabel,
  });
}
