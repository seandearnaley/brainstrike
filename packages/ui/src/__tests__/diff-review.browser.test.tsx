import './diff-review.browser.css';
import type { StructuredFileDiff } from '@brainstrike/types';
import { cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { type DiffComment, DiffReview, type DiffReviewFile } from '../diff-view';
import { ThemeProvider } from '../theme-provider';
import { Toaster } from '../toaster';

afterEach(cleanup);
beforeEach(async () => {
  await page.viewport(1000, 700);
});

const OLD = 'import { a } from "./a";\n\nexport function sum(x, y) {\n  return x + y;\n}\n';
const NEW =
  'import { a } from "./a";\n\nexport function sum(x: number, y: number) {\n  return x + y;\n}\n';

function patchOf(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,5 +1,5 @@',
    ' import { a } from "./a";',
    ' ',
    '-export function sum(x, y) {',
    '+export function sum(x: number, y: number) {',
    '   return x + y;',
    ' }',
    '',
  ].join('\n');
}

const FILES: DiffReviewFile[] = [
  {
    additions: 1,
    deletions: 1,
    id: 'sum',
    patch: patchOf('src/sum.ts'),
    path: 'src/sum.ts',
    status: 'modified',
  },
  {
    additions: null,
    deletions: null,
    id: 'logo',
    patch: null,
    path: 'assets/logo.png',
    status: 'added',
  },
  { additions: 1, deletions: 1, id: 'big', patch: null, path: 'src/big.ts', status: 'modified' },
];

function loaded(path: string): StructuredFileDiff {
  return {
    additions: 1,
    content: { kind: 'full', newContent: NEW, oldContent: OLD, patch: patchOf(path) },
    deletions: 1,
    path,
    status: 'modified',
  };
}

const loadById = async (id: string) => loaded(FILES.find((file) => file.id === id)?.path ?? id);

function Review({
  diffStyle = 'unified',
  files = FILES,
  loadFile = loadById,
  onComment = () => {},
}: {
  readonly diffStyle?: 'split' | 'unified';
  readonly files?: readonly DiffReviewFile[];
  readonly loadFile?: (id: string) => Promise<StructuredFileDiff>;
  readonly onComment?: (comment: DiffComment) => void;
}) {
  const [comments, setComments] = useState<DiffComment[]>([]);
  return (
    <ThemeProvider defaultMode="light">
      <div style={{ height: 560, width: 900 }}>
        <DiffReview
          comments={comments}
          diffStyle={diffStyle}
          files={files}
          loadFile={loadFile}
          onComment={(comment) => {
            onComment(comment);
            setComments((current) => [...current.filter((c) => c.id !== comment.id), comment]);
          }}
          onDeleteComment={(id) => setComments((current) => current.filter((c) => c.id !== id))}
        />
      </div>
      <Toaster />
    </ThemeProvider>
  );
}

/** The + the diff shows beside the hovered line. */
function commentButton(): HTMLElement {
  for (const host of document.querySelectorAll('diffs-container')) {
    const button = host.shadowRoot?.querySelector<HTMLElement>('[data-utility-button]');
    if (button) {
      return button;
    }
  }
  throw new Error('No comment button is showing.');
}

test('every file shows in one scroll with its counts', async () => {
  render(<Review />);
  await expect.element(page.getByText('export function sum(x: number, y: number) {')).toBeVisible();
  await expect.element(page.getByText('1 additions, 1 deletions').first()).toBeInTheDocument();
  await expect.element(page.getByText('Binary')).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: 'src/big.ts' }))
    .toHaveAttribute('aria-expanded', 'false');
});

test('a folded file loads when opened, and folds again', async () => {
  const loadFile = vi.fn(loadById);
  render(<Review loadFile={loadFile} />);
  const header = page.getByRole('button', { name: 'src/big.ts' });
  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  expect(loadFile).toHaveBeenCalledWith('big');
  await expect.element(page.getByText('export function sum(x, y) {').nth(1)).toBeVisible();

  const sum = page.getByRole('button', { name: 'src/sum.ts' });
  await sum.click();
  await expect.element(sum).toHaveAttribute('aria-expanded', 'false');
  expect(loadFile).toHaveBeenCalledTimes(1);
});

test('a new file the view did not diff opens with its counts', async () => {
  const patch = [
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    'index 0000000..2222222',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+export const one = 1;',
    '+export const two = 2;',
    '',
  ].join('\n');
  render(
    <Review
      files={[
        {
          additions: null,
          deletions: null,
          id: 'new',
          patch: null,
          path: 'src/new.ts',
          status: 'untracked',
        },
      ]}
      loadFile={async () => ({
        additions: 2,
        content: { kind: 'hunks-only', patch, patchTruncated: false, reason: 'diff-overflow' },
        deletions: 0,
        path: 'src/new.ts',
        status: 'untracked',
      })}
    />
  );
  const header = page.getByRole('button', { name: 'src/new.ts' });
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await header.click();
  await expect.element(page.getByText('export const two = 2;')).toBeVisible();
  await expect.element(page.getByText('2 additions, 0 deletions')).toBeInTheDocument();
});

test('a file that cannot load says why and stays folded', async () => {
  render(<Review loadFile={() => Promise.reject(new Error('git exited with 128'))} />);
  const header = page.getByRole('button', { name: 'src/big.ts' });
  await header.click();
  await expect.element(page.getByText("Couldn't load src/big.ts")).toBeVisible();
  await expect.element(page.getByText('git exited with 128')).toBeVisible();
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
});

test('a comment quotes its line and stays on the diff until deleted', async () => {
  const onComment = vi.fn();
  render(<Review onComment={onComment} />);
  await userEvent.hover(page.getByText('return x + y;'));
  await userEvent.click(commentButton());
  const box = page.getByRole('textbox', { name: 'Comment on line 4' });
  await expect.element(box).toHaveFocus();
  await userEvent.type(box, 'Check overflow');
  await userEvent.keyboard('{Control>}{Enter}{/Control}');

  expect(onComment).toHaveBeenCalledWith(
    expect.objectContaining({
      endLine: 4,
      fileId: 'sum',
      lines: ['  return x + y;'],
      side: 'additions',
      startLine: 4,
      text: 'Check overflow',
    })
  );
  await expect.element(page.getByRole('button', { name: 'Check overflow' })).toBeVisible();
  await expect.element(box).not.toBeInTheDocument();

  await page.getByRole('button', { name: 'Delete comment' }).click();
  await expect
    .element(page.getByRole('button', { name: 'Check overflow' }))
    .not.toBeInTheDocument();
});

test('Escape closes a comment box without saving', async () => {
  const onComment = vi.fn();
  render(<Review onComment={onComment} />);
  await userEvent.hover(page.getByText('return x + y;'));
  await userEvent.click(commentButton());
  const box = page.getByRole('textbox', { name: 'Comment on line 4' });
  await userEvent.type(box, 'draft');
  await userEvent.keyboard('{Escape}');
  await expect.element(box).not.toBeInTheDocument();
  expect(onComment).not.toHaveBeenCalled();
});

test('side by side, a comment on a removed line names the old version', async () => {
  const onComment = vi.fn();
  render(<Review diffStyle="split" onComment={onComment} />);
  await userEvent.hover(page.getByText('export function sum(x, y) {'));
  await userEvent.click(commentButton());
  const box = page.getByRole('textbox', { name: 'Comment on old line 3' });
  await userEvent.type(box, 'Why untyped?');
  await page.getByRole('button', { exact: true, name: 'Comment' }).click();
  expect(onComment).toHaveBeenCalledWith(
    expect.objectContaining({
      lines: ['export function sum(x, y) {'],
      side: 'deletions',
      startLine: 3,
    })
  );
});

test('inline, a removed line takes a comment on the old version', async () => {
  const onComment = vi.fn();
  render(<Review onComment={onComment} />);
  await userEvent.hover(page.getByText('export function sum(x, y) {'));
  await userEvent.click(commentButton());
  const box = page.getByRole('textbox', { name: 'Comment on old line 3' });
  await userEvent.type(box, 'Why untyped?');
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  expect(onComment).toHaveBeenCalledWith(
    expect.objectContaining({ lines: ['export function sum(x, y) {'], side: 'deletions' })
  );
});

test('an open comment keeps its text when the view switches between inline and split', async () => {
  const { rerender } = render(<Review />);
  await userEvent.hover(page.getByText('return x + y;'));
  await userEvent.click(commentButton());
  await userEvent.type(page.getByRole('textbox', { name: 'Comment on line 4' }), 'half written');
  rerender(<Review diffStyle="split" />);
  await expect
    .element(page.getByRole('textbox', { name: 'Comment on line 4' }))
    .toHaveValue('half written');
});

test('side by side, a file replaced by a symlink shows both versions', async () => {
  const patch = [
    'diff --git a/link b/link',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/link',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-first old line',
    '-second old line',
    'diff --git a/link b/link',
    'new file mode 120000',
    'index 0000000..2222222',
    '--- /dev/null',
    '+++ b/link',
    '@@ -0,0 +1 @@',
    '+../elsewhere',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  render(
    <Review
      diffStyle="split"
      files={[{ additions: 1, deletions: 2, id: 'link', patch, path: 'link', status: 'modified' }]}
    />
  );
  await expect.element(page.getByText('second old line')).toBeVisible();
  await expect.element(page.getByText('../elsewhere')).toBeVisible();
});

function bigVersion(line: string): StructuredFileDiff {
  return {
    additions: 1,
    content: {
      kind: 'hunks-only',
      patch: [
        'diff --git a/src/big.ts b/src/big.ts',
        'index 1111111..2222222 100644',
        '--- a/src/big.ts',
        '+++ b/src/big.ts',
        '@@ -1 +1 @@',
        '-old',
        `+${line}`,
        '',
      ].join('\n'),
      patchTruncated: false,
      reason: 'over-cap-new',
    },
    deletions: 1,
    path: 'src/big.ts',
    status: 'modified',
  };
}

test('an opened file shows its newest version after the view refreshes', async () => {
  let current = bigVersion('first version');
  const big: DiffReviewFile = {
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    status: 'modified',
  };
  const { rerender } = render(<Review files={[big]} loadFile={async () => current} />);
  await page.getByRole('button', { name: 'src/big.ts' }).click();
  await expect.element(page.getByText('first version')).toBeVisible();

  // Still too large for the view: it loads again.
  current = bigVersion('second version');
  rerender(<Review files={[{ ...big }]} loadFile={async () => current} />);
  await expect.element(page.getByText('second version')).toBeVisible();

  // Now the view carries its patch, which wins over the loaded copy.
  const patch = bigVersion('third version').content;
  rerender(
    <Review
      files={[{ ...big, patch: patch.kind === 'binary' ? null : patch.patch }]}
      loadFile={async () => current}
    />
  );
  await expect.element(page.getByText('third version')).toBeVisible();
});

test('a read that finishes after a newer one never replaces it', async () => {
  let finishFirst: (diff: StructuredFileDiff) => void = () => {};
  const first = new Promise<StructuredFileDiff>((resolve) => {
    finishFirst = resolve;
  });
  let loadFile = (): Promise<StructuredFileDiff> => first;
  const big: DiffReviewFile = {
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    status: 'modified',
  };
  const { rerender } = render(<Review files={[big]} loadFile={() => loadFile()} />);
  const header = page.getByRole('button', { name: 'src/big.ts' });
  await header.click();
  await expect.element(header).toBeDisabled();

  // The view refreshes while the first read is still out.
  loadFile = async () => bigVersion('newer version');
  rerender(<Review files={[{ ...big }]} loadFile={() => loadFile()} />);
  await expect.element(page.getByText('newer version')).toBeVisible();

  finishFirst(bigVersion('older version'));
  // The first read has settled once its spinner stops.
  await expect.element(header).toBeEnabled();
  await expect.element(page.getByText('newer version')).toBeVisible();
  await expect.element(page.getByText('older version')).not.toBeInTheDocument();
});
