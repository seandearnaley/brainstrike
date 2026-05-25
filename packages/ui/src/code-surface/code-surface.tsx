import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
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

export interface CodeSurfaceProps {
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  readonly editable?: boolean | undefined;
  readonly initialScrollTop?: number | undefined;
  readonly language?: string | undefined;
  readonly lineWrapping?: boolean | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  readonly onSelectionChange?: ((selection: CodeSurfaceSelection) => void) | undefined;
  readonly path?: string | undefined;
  readonly testId?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly value: string;
}

interface CodeSurfaceCallbacks {
  readonly onChange: ((value: string) => void) | undefined;
  readonly onScrollTopChange: ((scrollTop: number) => void) | undefined;
  readonly onSelectionChange: ((selection: CodeSurfaceSelection) => void) | undefined;
}

const MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const BASE_EXTENSIONS: Extension[] = [
  highlightSpecialChars(),
  lineNumbers(),
  highlightActiveLineGutter(),
  drawSelection(),
  rectangularSelection(),
  highlightActiveLine(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.theme({
    '&': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
      height: '100%',
      minHeight: '100%',
    },
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
  }),
];

export function CodeSurface({
  ariaLabel = 'Code viewer',
  className,
  editable = false,
  initialScrollTop = 0,
  language,
  lineWrapping = false,
  onChange,
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
  const applyingExternalValueRef = useRef(false);
  const callbacksRef = useRef<CodeSurfaceCallbacks>({
    onChange,
    onScrollTopChange,
    onSelectionChange,
  });

  const resolvedLanguage = useMemo<CodeSurfaceLanguageResolution>(
    () => resolveCodeSurfaceLanguage({ language, path }),
    [language, path]
  );

  useEffect(() => {
    callbacksRef.current = {
      onChange,
      onScrollTopChange,
      onSelectionChange,
    };
  }, [onChange, onScrollTopChange, onSelectionChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...BASE_EXTENSIONS,
          wrappingCompartmentRef.current.of(lineWrapping ? EditorView.lineWrapping : []),
          editableCompartmentRef.current.of(createEditableExtensions(editable)),
          contentAttributesCompartmentRef.current.of(createContentAttributes(ariaLabel)),
          languageCompartmentRef.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternalValueRef.current) {
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
      view.scrollDOM.scrollTop = Math.max(0, initialScrollTop);
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
    applyingExternalValueRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        insert: value,
        to: currentValue.length,
      },
      selection: EditorSelection.cursor(0),
    });
    applyingExternalValueRef.current = false;
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

    if (!resolvedLanguage.description) {
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure([]),
      });
      return;
    }

    void resolvedLanguage.description
      .load()
      .then((support) => {
        if (cancelled || viewRef.current !== view) {
          return;
        }
        view.dispatch({
          effects: languageCompartmentRef.current.reconfigure(support),
        });
      })
      .catch(() => {
        // CodeMirror language packages are optional at runtime; keep plaintext fallback.
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
