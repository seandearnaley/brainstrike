/**
 * Line comments on a diff (BST-2333). When its consumer passes
 * `onLineComment`, each editor `DiffView` mounts gets a + on every line that
 * is a real file line; it shows on the hovered line. The + opens a comment
 * box under that line, or under the selection when the selection covers it,
 * and Cmd/Ctrl+Enter hands the comment to the consumer. One box is open at a
 * time across the view's editors. The box is React
 * (`diff-view-line-comment-box.tsx`), portalled into a CodeMirror block
 * widget, which CodeMirror leaves its events to.
 */
import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, WidgetType } from '@codemirror/view';

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

/** The open box: where it renders and what it comments on. */
export interface OpenLineComment {
  readonly host: HTMLElement;
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

/** The selection's lines when it covers `line`, else `line` alone. */
function rangeAt(state: EditorState, line: number): OpenRange {
  const selection = state.selection.main;
  let fromLine = line;
  let toLine = line;
  if (!selection.empty) {
    const first = state.doc.lineAt(selection.from).number;
    const end = state.doc.lineAt(selection.to);
    // A selection of whole lines ends at the start of the next one.
    const last = end.from === selection.to && end.number > first ? end.number - 1 : end.number;
    if (line >= first && line <= last) {
      fromLine = first;
      toLine = last;
    }
  }
  return { at: state.doc.line(toLine).to, fromLine, toLine };
}

export function createLineCommentController(
  onChange: (open: OpenLineComment | null) => void
): LineCommentController {
  let current: OpenLineComment | null = null;
  let nextId = 0;

  const close = (): void => {
    const open = current;
    if (!open) {
      return;
    }
    open.view.dispatch({ effects: setOpenRange.of(null) });
    open.view.dom
      .querySelector<HTMLElement>(`.cm-line-comment-add[data-line="${open.target.startLine}"]`)
      ?.focus();
  };

  const extension = (side: DiffLineSide, fileLineOf: DiffFileLineOf): Extension => {
    const targetOf = (state: EditorState, range: OpenRange): DiffLineTarget => {
      const fileLines: number[] = [];
      const lines: string[] = [];
      for (let line = range.fromLine; line <= range.toLine; line += 1) {
        const fileLine = fileLineOf(line);
        if (fileLine !== null) {
          fileLines.push(fileLine);
          lines.push(state.doc.line(line).text);
        }
      }
      const [startLine] = fileLines;
      const endLine = fileLines.at(-1);
      if (startLine === undefined || endLine === undefined) {
        throw new Error('A diff comment opened on lines that are not file lines.');
      }
      return { endLine, lines, side, startLine };
    };

    class CommentBoxWidget extends WidgetType {
      readonly range: OpenRange;

      constructor(range: OpenRange) {
        super();
        this.range = range;
      }

      override eq(other: CommentBoxWidget): boolean {
        return (
          other.range.fromLine === this.range.fromLine && other.range.toLine === this.range.toLine
        );
      }

      override toDOM(view: EditorView): HTMLElement {
        const host = document.createElement('div');
        host.className = 'cm-line-comment';
        nextId += 1;
        current = { host, id: nextId, target: targetOf(view.state, this.range), view };
        onChange(current);
        return host;
      }

      override destroy(dom: HTMLElement): void {
        if (current?.host === dom) {
          current = null;
          onChange(null);
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
                  widget: new CommentBoxWidget(range),
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
      if (current && current.view !== view) {
        current.view.dispatch({ effects: setOpenRange.of(null) });
      }
      view.dispatch({ effects: setOpenRange.of(rangeAt(view.state, line)) });
    };

    return [
      hoveredLineField,
      openRangeField,
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
