import './diff-review.browser.css';
import type { ChangesAction, StructuredFileDiff } from '@brainstrike/types';
import { cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { type DiffComment, DiffReview, type DiffReviewFile } from '../diff-view';
import { ThemeProvider } from '../theme-provider';
import { Toaster } from '../toaster';
import { TooltipProvider } from '../tooltip';

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
    actions: [],
    additions: 1,
    deletions: 1,
    id: 'sum',
    patch: patchOf('src/sum.ts'),
    path: 'src/sum.ts',
    revision: 'sum-1',
    status: 'modified',
  },
  {
    actions: [],
    additions: null,
    deletions: null,
    id: 'logo',
    patch: null,
    path: 'assets/logo.png',
    revision: 'logo-1',
    status: 'added',
  },
  {
    actions: [],
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    revision: 'big-1',
    status: 'modified',
  },
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

type OnAction = (
  action: ChangesAction,
  file: DiffReviewFile,
  hunks: readonly string[] | null
) => void;

function Review({
  actionsDisabled,
  diffStyle = 'unified',
  files = FILES,
  loadFile = loadById,
  onAction,
  onComment = () => {},
}: {
  readonly actionsDisabled?: boolean;
  readonly diffStyle?: 'split' | 'unified';
  readonly files?: readonly DiffReviewFile[];
  readonly loadFile?: (id: string) => Promise<StructuredFileDiff>;
  readonly onAction?: OnAction;
  readonly onComment?: (comment: DiffComment) => void;
}) {
  const [comments, setComments] = useState<DiffComment[]>([]);
  return (
    <ThemeProvider defaultMode="light">
      <TooltipProvider>
        <div style={{ height: 560, width: 900 }}>
          <DiffReview
            actionsDisabled={actionsDisabled}
            comments={comments}
            diffStyle={diffStyle}
            files={files}
            loadFile={loadFile}
            onAction={onAction}
            onComment={(comment) => {
              onComment(comment);
              setComments((current) => [...current.filter((c) => c.id !== comment.id), comment]);
            }}
            onDeleteComment={(id) => setComments((current) => current.filter((c) => c.id !== id))}
          />
        </div>
        <Toaster />
      </TooltipProvider>
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

test('files that start folded open one at a time, inside a box that grows to its cap', async () => {
  const loadFile = vi.fn(loadById);
  render(
    <ThemeProvider defaultMode="light">
      <div style={{ width: 900 }}>
        <DiffReview
          className="max-h-[320px]"
          defaultCollapsed
          diffStyle="unified"
          files={FILES}
          loadFile={loadFile}
        />
      </div>
    </ThemeProvider>
  );
  const sum = page.getByRole('button', { name: 'src/sum.ts' });
  const big = page.getByRole('button', { name: 'src/big.ts' });
  await expect.element(sum).toHaveAttribute('aria-expanded', 'false');
  await expect.element(big).toHaveAttribute('aria-expanded', 'false');
  const line = page.getByText('export function sum(x: number, y: number) {');
  await expect.element(line).not.toBeInTheDocument();
  const region = page.getByTestId('diff-review').element().firstElementChild as HTMLElement;
  const folded = region.getBoundingClientRect().height;
  expect(folded).toBeGreaterThan(0);
  expect(folded).toBeLessThan(320);

  await sum.click();
  await expect.element(sum).toHaveAttribute('aria-expanded', 'true');
  await expect.element(line).toBeVisible();
  expect(region.getBoundingClientRect().height).toBeGreaterThan(folded);

  // A file the view sent without its patch loads, then opens.
  await big.click();
  await expect.element(big).toHaveAttribute('aria-expanded', 'true');
  expect(loadFile).toHaveBeenCalledWith('big');
  await expect.poll(() => region.getBoundingClientRect().height).toBe(320);

  await sum.click();
  await expect.element(sum).toHaveAttribute('aria-expanded', 'false');
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
          actions: [],
          additions: null,
          deletions: null,
          id: 'new',
          patch: null,
          path: 'src/new.ts',
          revision: 'new-1',
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
      files={[
        {
          actions: [],
          additions: 1,
          deletions: 2,
          id: 'link',
          patch,
          path: 'link',
          revision: 'link-1',
          status: 'modified',
        },
      ]}
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
    actions: [],
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    revision: 'big-1',
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
    actions: [],
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    revision: 'big-1',
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

const FIRST_HUNK = [
  '@@ -1,4 +1,4 @@',
  '-const a = 1;',
  '+const a = 2;',
  ' const b = 1;',
  ' const c = 1;',
  ' const d = 1;',
  '',
].join('\n');
const SECOND_HUNK = [
  '@@ -10,4 +10,3 @@ export function f() {',
  ' const j = 1;',
  ' const k = 1;',
  '-const l = 1;',
  '-const m = 1;',
  '+const m = 2;',
  '',
].join('\n');
const TWO_HUNKS: DiffReviewFile = {
  actions: [],
  additions: 2,
  deletions: 3,
  id: 'two',
  patch: [
    'diff --git a/src/two.ts b/src/two.ts',
    'index 1111111..2222222 100644',
    '--- a/src/two.ts',
    '+++ b/src/two.ts',
    FIRST_HUNK + SECOND_HUNK,
  ].join('\n'),
  path: 'src/two.ts',
  revision: 'two-1',
  status: 'modified',
};

function offering(file: DiffReviewFile, actions: readonly ChangesAction[]): DiffReviewFile {
  return { ...file, actions };
}

function hunkButtons(name: string) {
  return page.getByRole('button', { exact: true, name });
}

test('each hunk of a modified file offers its actions and hands back its own hunk', async () => {
  const onAction = vi.fn<OnAction>();
  const file = offering(TWO_HUNKS, ['stage', 'revert']);
  render(<Review files={[file]} onAction={onAction} />);
  await expect.element(hunkButtons('Stage').nth(1)).toBeVisible();
  expect(hunkButtons('Stage').elements()).toHaveLength(2);
  expect(hunkButtons('Revert').elements()).toHaveLength(2);

  await hunkButtons('Stage').nth(1).click();
  expect(onAction).toHaveBeenLastCalledWith('stage', file, [SECOND_HUNK]);
  await hunkButtons('Revert').first().click();
  expect(onAction).toHaveBeenLastCalledWith('revert', file, [FIRST_HUNK]);
});

test('side by side, a hunk that removes more than it adds keeps its actions under its end', async () => {
  const onAction = vi.fn<OnAction>();
  const file = offering(TWO_HUNKS, ['unstage']);
  render(<Review diffStyle="split" files={[file]} onAction={onAction} />);
  const unstage = hunkButtons('Unstage').nth(1);
  await expect.element(unstage).toBeVisible();
  const removed = page.getByText('const m = 1;').element().getBoundingClientRect();
  expect(unstage.element().getBoundingClientRect().top).toBeGreaterThan(removed.bottom);
  await unstage.click();
  expect(onAction).toHaveBeenLastCalledWith('unstage', file, [SECOND_HUNK]);
});

test('each file header offers its own actions; only a modified file offers them per hunk', async () => {
  const onAction = vi.fn<OnAction>();
  const added: DiffReviewFile = {
    actions: ['stage', 'revert'],
    additions: 1,
    deletions: 0,
    id: 'added',
    patch: [
      'diff --git a/src/added.ts b/src/added.ts',
      'new file mode 100644',
      'index 0000000..2222222',
      '--- /dev/null',
      '+++ b/src/added.ts',
      '@@ -0,0 +1 @@',
      '+export const added = 1;',
      '',
    ].join('\n'),
    path: 'src/added.ts',
    revision: 'added-1',
    status: 'untracked',
  };
  const binary: DiffReviewFile = {
    actions: ['stage'],
    additions: null,
    deletions: null,
    id: 'logo',
    patch: null,
    path: 'assets/logo.png',
    revision: 'logo-1',
    status: 'modified',
  };
  render(<Review files={[added, binary, offering(TWO_HUNKS, ['revert'])]} onAction={onAction} />);
  await expect.element(page.getByText('export const added = 1;')).toBeVisible();
  for (const name of [
    'Stage src/added.ts',
    'Revert src/added.ts',
    'Stage assets/logo.png',
    'Revert src/two.ts',
  ]) {
    await expect.element(page.getByRole('button', { name })).toBeVisible();
  }
  for (const name of ['Revert assets/logo.png', 'Stage src/two.ts']) {
    expect(page.getByRole('button', { name }).elements()).toHaveLength(0);
  }
  await expect.element(hunkButtons('Revert').nth(1)).toBeVisible();
  expect(hunkButtons('Revert').elements()).toHaveLength(2);
  expect(hunkButtons('Stage').elements()).toHaveLength(0);

  const stageBinary = page.getByRole('button', { name: 'Stage assets/logo.png' });
  await userEvent.hover(stageBinary);
  await expect.element(page.getByRole('tooltip', { name: 'Stage' })).toBeInTheDocument();
  await stageBinary.click();
  expect(onAction).toHaveBeenLastCalledWith('stage', binary, null);
});

test('a file whose hunks cannot be taken one at a time offers its actions on its header only', async () => {
  const undecoded = offering(
    {
      ...TWO_HUNKS,
      patch: (TWO_HUNKS.patch ?? '').replace('const a = 2;', 'const a = "\uFFFD";'),
    },
    ['stage']
  );
  render(<Review files={[undecoded]} onAction={() => {}} />);
  await expect.element(page.getByText('const m = 2;')).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Stage src/two.ts' })).toBeVisible();
  expect(hunkButtons('Stage').elements()).toHaveLength(0);
});

test('a file whose actions take only the whole file offers them on its header only', async () => {
  const onAction = vi.fn<OnAction>();
  const file: DiffReviewFile = { ...offering(TWO_HUNKS, ['revert']), wholeFile: true };
  render(<Review files={[file]} onAction={onAction} />);
  await expect.element(page.getByText('const m = 2;')).toBeVisible();
  await page.getByRole('button', { name: 'Revert src/two.ts' }).click();
  expect(onAction).toHaveBeenLastCalledWith('revert', file, null);
  expect(hunkButtons('Revert').elements()).toHaveLength(0);
});

test('while an action runs, no action can start', async () => {
  render(<Review actionsDisabled files={[offering(TWO_HUNKS, ['stage'])]} onAction={() => {}} />);
  await expect.element(hunkButtons('Stage').nth(1)).toBeDisabled();
  await expect.element(hunkButtons('Stage').first()).toBeDisabled();
  await expect.element(page.getByRole('button', { name: 'Stage src/two.ts' })).toBeDisabled();
});

test('a comment on a hunk’s last change sits above the hunk’s actions', async () => {
  render(<Review files={[offering(TWO_HUNKS, ['stage'])]} onAction={() => {}} />);
  await userEvent.hover(page.getByText('const a = 2;'));
  await userEvent.click(commentButton());
  const box = page.getByRole('textbox', { name: 'Comment on line 1' });
  await userEvent.type(box, 'Why 2?');
  await userEvent.keyboard('{Control>}{Enter}{/Control}');
  const note = page.getByRole('button', { name: 'Why 2?' });
  await expect.element(note).toBeVisible();
  const stage = hunkButtons('Stage').first();
  await expect.element(stage).toBeVisible();
  expect(stage.element().getBoundingClientRect().top).toBeGreaterThan(
    note.element().getBoundingClientRect().bottom
  );
});

test('a file that changed after it loaded never offers its old hunks, and reads itself again', async () => {
  const onAction = vi.fn<OnAction>();
  let loadFile = async (): Promise<StructuredFileDiff> => bigVersion('first version');
  const big: DiffReviewFile = {
    actions: ['stage'],
    additions: 1,
    deletions: 1,
    id: 'big',
    patch: null,
    path: 'src/big.ts',
    revision: 'big-1',
    status: 'modified',
  };
  const { rerender } = render(
    <Review files={[big]} loadFile={() => loadFile()} onAction={onAction} />
  );
  await page.getByRole('button', { name: 'src/big.ts' }).click();
  await expect.element(page.getByText('first version')).toBeVisible();
  await expect.element(hunkButtons('Stage')).toBeVisible();

  // Staging its hunk changed the file; its next read is still out.
  let finish: (diff: StructuredFileDiff) => void = () => {};
  loadFile = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const changed = { ...big, revision: 'big-2' };
  rerender(<Review files={[changed]} loadFile={() => loadFile()} onAction={onAction} />);
  await expect.element(page.getByText('first version')).not.toBeInTheDocument();
  expect(hunkButtons('Stage').elements()).toHaveLength(0);

  finish(bigVersion('second version'));
  await expect.element(page.getByText('second version')).toBeVisible();
  await hunkButtons('Stage').click();
  expect(onAction).toHaveBeenLastCalledWith('stage', changed, [
    '@@ -1 +1 @@\n-old\n+second version\n',
  ]);
});
