/**
 * BST-2333: a comment on a diff line, in real Chromium. CodeMirror finds the
 * clicked gutter line from layout, which only a real browser has. Its gutters
 * are hidden from assistive tech, so the + buttons are queried with `hidden`.
 */
import type { StructuredFileDiff } from '@brainstrike/types';
import { EditorView } from '@codemirror/view';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { DiffLineComment, DiffViewProps } from '../diff-view';
import { DiffView } from '../diff-view';
import './diff-view-line-comments.browser.css';

const ORIGINAL = 'const first = 1;\nconst answer = 41;\nconst last = 3;\n';
const MODIFIED = 'const first = 1;\nconst answer = 42;\nconst last = 3;\n';

function renderDiff(
  defaultMode: 'split' | 'unified',
  onLineComment = vi.fn(() => true),
  content: DiffViewProps = { modified: MODIFIED, original: ORIGINAL }
) {
  render(
    <div style={{ height: 400 }}>
      <DiffView
        {...content}
        defaultMode={defaultMode}
        onLineComment={onLineComment}
        testId="diff"
      />
    </div>
  );
  return onLineComment;
}

/** The unified diff's editor. */
function unifiedEditor(): EditorView {
  const editor = document.querySelector<HTMLElement>('[data-testid="diff"] .cm-editor');
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view) {
    throw new Error('The unified diff mounted no editor.');
  }
  return view;
}

/** Clicks the + of `line`, then writes in the box for `target` (the line, or the selection it covers). */
async function writeComment(line: string, text: string, target = line): Promise<void> {
  await userEvent.click(screen.getByRole('button', { hidden: true, name: `Comment on ${line}` }));
  const box = await screen.findByRole('textbox', { name: `Comment on ${target}` });
  await waitFor(() => expect(document.activeElement).toBe(box));
  await userEvent.type(box, text);
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
}

test('the + shows on the line the pointer is over', async () => {
  renderDiff('unified');
  const add = screen.getByRole('button', { hidden: true, name: 'Comment on new line 2' });
  expect(getComputedStyle(add).opacity).toBe('0');
  const line = [...document.querySelectorAll('[data-testid="diff"] .cm-line')].find(
    (element) => element.textContent === 'const answer = 42;'
  );
  if (!line) {
    throw new Error('The unified diff shows no new line 2.');
  }
  await userEvent.hover(line);
  await waitFor(() =>
    expect(
      getComputedStyle(screen.getByRole('button', { hidden: true, name: 'Comment on new line 2' }))
        .opacity
    ).toBe('1')
  );
});

test('a + on a new line takes a comment, which Ctrl+Enter hands over', async () => {
  const onLineComment = renderDiff('unified');
  await writeComment('new line 2', 'Explain why it is 42.');
  expect(onLineComment).toHaveBeenCalledWith({
    endLine: 2,
    lines: ['const answer = 42;'],
    side: 'modified',
    startLine: 2,
    text: 'Explain why it is 42.',
  } satisfies DiffLineComment);
  expect(screen.queryByTestId('diff-line-comment-box')).toBeNull();
});

test('side by side, the old side takes comments too', async () => {
  const onLineComment = renderDiff('split');
  await writeComment('old line 2', 'Was 41 ever right?');
  expect(onLineComment).toHaveBeenCalledWith(
    expect.objectContaining({ lines: ['const answer = 41;'], side: 'original', startLine: 2 })
  );
});

test('a selection that covers the clicked line comments on all its lines', async () => {
  const onLineComment = renderDiff('unified');
  const view = unifiedEditor();
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.line(3).to } });
  await writeComment('new line 2', 'These three belong together.', 'new lines 1–3');
  expect(onLineComment).toHaveBeenCalledWith(
    expect.objectContaining({
      endLine: 3,
      lines: ['const first = 1;', 'const answer = 42;', 'const last = 3;'],
      startLine: 1,
    })
  );
});

test('a selection across a hidden stretch of a large file comments only on the lines beside the click', async () => {
  // Over the size at which DiffView shows only the changed regions, with a
  // hidden stretch between the edits at lines 1000 and 1040.
  const fileLine = (line: number, text = "'unchanged'"): string =>
    `const value_${String(line).padStart(6, '0')} = ${text};`;
  const original = Array.from({ length: 8000 }, (_, index) => fileLine(index + 1));
  const modified = original.map((text, index) =>
    index + 1 === 1000 || index + 1 === 1040 ? fileLine(index + 1, "'changed'") : text
  );
  const diff: StructuredFileDiff = {
    additions: 2,
    content: {
      kind: 'full',
      newContent: `${modified.join('\n')}\n`,
      oldContent: `${original.join('\n')}\n`,
    },
    deletions: 2,
    hunks: [997, 1037].map((start) => ({
      newLines: 7,
      newStart: start,
      oldLines: 7,
      oldStart: start,
    })),
    path: 'src/values.ts',
    status: 'modified',
  };
  const onLineComment = renderDiff('unified', undefined, {
    // No language to load, which would remount the editor and drop the selection.
    language: 'plain',
    source: { diff, kind: 'structured' },
  });
  await screen.findByTestId('diff-sliced-note');
  const view = unifiedEditor();
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  await writeComment('new line 1000', 'Only this region.', 'new lines 991–1009');
  expect(onLineComment).toHaveBeenCalledWith(
    expect.objectContaining({ endLine: 1009, lines: modified.slice(990, 1009), startLine: 991 })
  );
});

test('a comment being written survives scrolling its line out of view and back', async () => {
  // Every fifth line changed, so no unchanged run is long enough to fold.
  const original = Array.from({ length: 1500 }, (_, index) => `line ${index + 1}`);
  const modified = original.map((text, index) =>
    (index + 1) % 5 === 0 ? `${text} changed` : text
  );
  const onLineComment = renderDiff('unified', undefined, {
    modified: `${modified.join('\n')}\n`,
    original: `${original.join('\n')}\n`,
  });
  await userEvent.click(
    screen.getByRole('button', { hidden: true, name: 'Comment on new line 2' })
  );
  const typed = await screen.findByRole('textbox', { name: 'Comment on new line 2' });
  await waitFor(() => expect(document.activeElement).toBe(typed));
  await userEvent.keyboard('Still here.');
  const scroller = unifiedEditor().scrollDOM;
  scroller.scrollTop = scroller.scrollHeight;
  // A click down there moves the editor's selection off the box's line, so
  // CodeMirror stops drawing that line and the box with it.
  const far = await waitFor(() => {
    const line = [...document.querySelectorAll('[data-testid="diff"] .cm-line')].find(
      (element) => element.textContent === 'line 1499'
    );
    if (!line) {
      throw new Error('The diff has not drawn line 1499 yet.');
    }
    return line;
  });
  await userEvent.click(far);
  await waitFor(() => expect(screen.queryByTestId('diff-line-comment-box')).toBeNull());
  scroller.scrollTop = 0;
  const box = await screen.findByRole('textbox', { name: 'Comment on new line 2' });
  expect(box).toHaveValue('Still here.');
  await userEvent.click(box);
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  expect(onLineComment).toHaveBeenCalledWith(
    expect.objectContaining({ lines: ['line 2'], startLine: 2, text: 'Still here.' })
  );
});

test('a comment being written survives a refresh that brings the same diff', async () => {
  // A live refresh hands DiffView a fresh source object with equal content.
  const diff = (): StructuredFileDiff => ({
    additions: 1,
    content: { kind: 'full', newContent: MODIFIED, oldContent: ORIGINAL },
    deletions: 1,
    hunks: [{ newLines: 3, newStart: 1, oldLines: 3, oldStart: 1 }],
    path: 'src/answer.ts',
    status: 'modified',
  });
  const view = () => (
    <div style={{ height: 400 }}>
      <DiffView
        defaultMode="unified"
        language="plain"
        // A fresh handler each render, as the Changes card passes one.
        onLineComment={() => true}
        source={{ diff: diff(), kind: 'structured' }}
        testId="diff"
      />
    </div>
  );
  const { rerender } = render(view());
  await userEvent.click(
    screen.getByRole('button', { hidden: true, name: 'Comment on new line 2' })
  );
  await userEvent.type(
    await screen.findByRole('textbox', { name: 'Comment on new line 2' }),
    'Half a thought'
  );
  rerender(view());
  expect(screen.getByRole('textbox', { name: 'Comment on new line 2' })).toHaveValue(
    'Half a thought'
  );
});

test('Escape closes the box and hands nothing over', async () => {
  const onLineComment = renderDiff('unified');
  await userEvent.click(
    screen.getByRole('button', { hidden: true, name: 'Comment on new line 1' })
  );
  await userEvent.type(
    await screen.findByRole('textbox', { name: 'Comment on new line 1' }),
    'Never mind'
  );
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('diff-line-comment-box')).toBeNull());
  expect(onLineComment).not.toHaveBeenCalled();
});

test('a comment the consumer could not take stays in its box', async () => {
  renderDiff(
    'unified',
    vi.fn(() => false)
  );
  await writeComment('new line 3', 'Keep me.');
  expect(screen.getByRole('textbox', { name: 'Comment on new line 3' })).toHaveValue('Keep me.');
});

test('without a consumer the diff has no comment gutter', async () => {
  render(<DiffView defaultMode="unified" modified={MODIFIED} original={ORIGINAL} testId="diff" />);
  await screen.findByTestId('diff');
  expect(screen.queryByRole('button', { hidden: true, name: /^Comment on/u })).toBeNull();
});
