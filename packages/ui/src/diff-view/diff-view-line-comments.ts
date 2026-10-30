/**
 * Line comments on a diff (BST-2333). When its consumer passes
 * `onLineComment`, each editor `DiffView` mounts gets a + on every line that
 * is a real file line; it shows on the hovered line. The + opens a comment
 * box under that line, or under the selection when the selection covers it,
 * and Cmd/Ctrl+Enter hands the comment to the consumer. One box is open at a
 * time across the view's editors. The box is React
 * (`diff-view-line-comment-box.tsx`), portalled into a CodeMirror block
 * widget, which CodeMirror leaves its events to. CodeMirror drops a widget
 * that scrolls out of its viewport and draws it again on the way back, so the
 * open box outlives its widget: only closing it, or its editor going away,
 * ends it.
 */
import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

export type DiffLineSide = 'modified' | 'original';

/** What a comment is on: consecutive file lines of one side, 1-based and inclusive. */
export interface DiffLineTarget {
  readonly endLine: number;
  /** The commented lines, as the diff shows them. */
  readonly lines: readonly string[];
  readonly side: DiffLineSide;
  readonly startLine: number;
}

export interface DiffLineComment extends DiffLineTarget {
  readonly text: string;
}

/**
 * Takes a comment; false keeps the box open with its text, for a consumer
 * that could not take it and has told the person why.
 */
export type DiffLineCommentHandler = (comment: DiffLineComment) => boolean;

/** A document line's file line, or null for a line that is not one (a slice's gap). */
export type DiffFileLineOf = (documentLine: number) => number | null;

/** The open box: what it comments on, and where it renders while its widget is drawn. */
export interface OpenLineComment {
  readonly host: HTMLElement | null;
  readonly id: number;
  readonly target: DiffLineTarget;
  readonly view: EditorView;
}

export interface LineCommentController {
  /** Closes the open box and gives focus back to its line's +. */
  close(): void;
  /** The comment gutter and box for one editor that shows `side`. */
  extension(side: DiffLineSide, fileLineOf: DiffFileLineOf): Extension;
}

/** Document lines, and the position the box renders after. */
interface OpenRange {
  readonly at: number;
  readonly fromLine: number;
  readonly toLine: number;
}

const SIDE_WORD: Record<DiffLineSide, string> = { modified: 'new', original: 'old' };

/** "new line 12" or "old lines 12–14". */
export function describeDiffLineTarget(target: DiffLineTarget): string {
  const side = SIDE_WORD[target.side];
  return target.startLine === target.endLine
    ? `${side} line ${target.startLine}`
    : `${side} lines ${target.startLine}–${target.endLine}`;
}

const setOpenRange = StateEffect.define<OpenRange | null>();
const setHoveredLine = StateEffect.define<number | null>();

const hoveredLineField = StateField.define<number | null>({
  create: () => null,
  update: (line, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredLine)) {
        return effect.value;
      }
    }
    return line;
  },
});

class AddCommentMarker extends GutterMarker {
  readonly fileLine: number;
  readonly hovered: boolean;
  readonly side: DiffLineSide;

  constructor(side: DiffLineSide, fileLine: number, hovered: boolean) {
    super();
    this.fileLine = fileLine;
    this.hovered = hovered;
    this.side = side;
  }

  override eq(other: AddCommentMarker): boolean {
    return (
      other.side === this.side && other.fileLine === this.fileLine && other.hovered === this.hovered
    );
  }

  override toDOM(): Node {
    const button = document.createElement('button');
    button.type = 'button';
    // The pointer's affordance: CodeMirror hides its gutters from assistive
    // tech, and the read-only diff has no keyboard line navigation to join.
    button.tabIndex = -1;
    button.className = this.hovered
      ? 'cm-line-comment-add cm-line-comment-add-hovered'
      : 'cm-line-comment-add';
    button.dataset['line'] = String(this.fileLine);
    button.setAttribute(
      'aria-label',
      `Comment on ${describeDiffLineTarget({ endLine: this.fileLine, lines: [], side: this.side, startLine: this.fileLine })}`
    );
    button.textContent = '+';
    return button;
  }
}

/** Gives the gutter the width of a + without being one. */
class AddCommentSpacer extends GutterMarker {
  override toDOM(): Node {
    const spacer = document.createElement('span');
    spacer.className = 'cm-line-comment-add';
    spacer.textContent = '+';
    return spacer;
  }
}

/** The selection's whole lines, when the selection covers `line`. */
function selectedLines(
  state: EditorState,
  line: number
): { readonly first: number; readonly last: number } | null {
  const selection = state.selection.main;
  if (selection.empty) {
    return null;
  }
  const first = state.doc.lineAt(selection.from).number;
  const end = state.doc.lineAt(selection.to);
  // A selection of whole lines ends at the start of the next one.
  const last = end.from === selection.to && end.number > first ? end.number - 1 : end.number;
  return line >= first && line <= last ? { first, last } : null;
}

export function createLineCommentController(
  onChange: (open: OpenLineComment | null) => void
): LineCommentController {
  let current: OpenLineComment | null = null;
  let nextId = 0;

  const publish = (open: OpenLineComment | null): void => {
    current = open;
    onChange(open);
  };

  const close = (): void => {
    const open = current;
    if (!open) {
      return;
    }
    publish(null);
    open.view.dispatch({ effects: setOpenRange.of(null) });
    open.view.dom
      .querySelector<HTMLElement>(`.cm-line-comment-add[data-line="${open.target.startLine}"]`)
      ?.focus();
  };

  const extension = (side: DiffLineSide, fileLineOf: DiffFileLineOf): Extension => {
    /** Whether document line `line` shows the file line right after `line - 1`'s. */
    const follows = (line: number): boolean => {
      const fileLine = fileLineOf(line);
      const previous = fileLineOf(line - 1);
      return fileLine !== null && previous !== null && fileLine === previous + 1;
    };

    /**
     * The selection's lines when it covers `line`, else `line` alone. A
     * selection reaches only as far as the file lines run on unbroken from
     * `line`, so a comment never spans a slice's gap.
     */
    const rangeAt = (state: EditorState, line: number): OpenRange => {
      const selected = selectedLines(state, line);
      let fromLine = line;
      let toLine = line;
      if (selected) {
        while (fromLine > selected.first && follows(fromLine)) {
          fromLine -= 1;
        }
        while (toLine < selected.last && follows(toLine + 1)) {
          toLine += 1;
        }
      }
      return { at: state.doc.line(toLine).to, fromLine, toLine };
    };

    const targetOf = (state: EditorState, range: OpenRange): DiffLineTarget => {
      const startLine = fileLineOf(range.fromLine);
      const endLine = fileLineOf(range.toLine);
      if (startLine === null || endLine === null) {
        throw new Error('A diff comment opened on lines that are not file lines.');
      }
      const lines: string[] = [];
      for (let line = range.fromLine; line <= range.toLine; line += 1) {
        lines.push(state.doc.line(line).text);
      }
      return { endLine, lines, side, startLine };
    };

    /** Where the open box renders; `open` publishes the box before its widget is drawn. */
    class CommentBoxWidget extends WidgetType {
      override toDOM(view: EditorView): HTMLElement {
        const host = document.createElement('div');
        host.className = 'cm-line-comment';
        if (current?.view === view) {
          publish({ ...current, host });
        }
        return host;
      }

      override destroy(dom: HTMLElement): void {
        if (current?.host === dom) {
          publish({ ...current, host: null });
        }
      }

      override ignoreEvent(): boolean {
        return true;
      }
    }

    const openRangeField = StateField.define<OpenRange | null>({
      create: () => null,
      provide: (field) =>
        EditorView.decorations.from(field, (range) =>
          range
            ? Decoration.set(
                Decoration.widget({
                  block: true,
                  side: 1,
                  widget: new CommentBoxWidget(),
                }).range(range.at)
              )
            : Decoration.none
        ),
      update: (range, transaction) => {
        for (const effect of transaction.effects) {
          if (effect.is(setOpenRange)) {
            return effect.value;
          }
        }
        return range;
      },
    });

    const open = (view: EditorView, line: number): void => {
      const previous = current;
      const range = rangeAt(view.state, line);
      const target = targetOf(view.state, range);
      if (
        previous?.view === view &&
        previous.target.startLine === target.startLine &&
        previous.target.endLine === target.endLine
      ) {
        // Already open on these lines, with its draft.
        return;
      }
      nextId += 1;
      publish({ host: null, id: nextId, target, view });
      if (previous && previous.view !== view) {
        previous.view.dispatch({ effects: setOpenRange.of(null) });
      }
      view.dispatch({ effects: setOpenRange.of(range) });
    };

    return [
      hoveredLineField,
      openRangeField,
      // An editor that goes away takes its open box with it.
      ViewPlugin.define((view) => ({
        destroy: () => {
          if (current?.view === view) {
            publish(null);
          }
        },
      })),
      gutter({
        class: 'cm-line-comment-gutter',
        domEventHandlers: {
          click: (view, block, event) => {
            if (
              !(event.target instanceof Element && event.target.closest('.cm-line-comment-add'))
            ) {
              return false;
            }
            open(view, view.state.doc.lineAt(block.from).number);
            return true;
          },
          // Keeps the selection a + comments on.
          mousedown: (_view, _block, event) => {
            event.preventDefault();
            return true;
          },
        },
        initialSpacer: () => new AddCommentSpacer(),
        lineMarker: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          const fileLine = fileLineOf(line);
          return fileLine === null
            ? null
            : new AddCommentMarker(side, fileLine, view.state.field(hoveredLineField) === line);
        },
        lineMarkerChange: (update) =>
          update.startState.field(hoveredLineField) !== update.state.field(hoveredLineField),
      }),
      EditorView.domEventHandlers({
        mouseleave: (_event, view) => {
          if (view.state.field(hoveredLineField) !== null) {
            view.dispatch({ effects: setHoveredLine.of(null) });
          }
        },
        mousemove: (event, view) => {
          const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
          const line = view.state.doc.lineAt(block.from).number;
          if (view.state.field(hoveredLineField) !== line) {
            view.dispatch({ effects: setHoveredLine.of(line) });
          }
        },
      }),
    ];
  };

  return { close, extension };
}
