/**
 * BST-2333: a comment on a diff line, in real Chromium. CodeMirror finds the
 * clicked gutter line from layout, which only a real browser has. Its gutters
 * are hidden from assistive tech, so the + buttons are queried with `hidden`.
 */
import { EditorView } from '@codemirror/view';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { DiffLineComment } from '../diff-view';
import { DiffView } from '../diff-view';

const ORIGINAL = 'const first = 1;\nconst answer = 41;\nconst last = 3;\n';
const MODIFIED = 'const first = 1;\nconst answer = 42;\nconst last = 3;\n';

function renderDiff(defaultMode: 'split' | 'unified', onLineComment = vi.fn(() => true)) {
  render(
    <div style={{ height: 400 }}>
      <DiffView
        defaultMode={defaultMode}
        modified={MODIFIED}
        onLineComment={onLineComment}
        original={ORIGINAL}
        testId="diff"
      />
    </div>
  );
  return onLineComment;
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
  const editor = document.querySelector<HTMLElement>('[data-testid="diff"] .cm-editor');
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view) {
    throw new Error('The unified diff mounted no editor.');
  }
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
