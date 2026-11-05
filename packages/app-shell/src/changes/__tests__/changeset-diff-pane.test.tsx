import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  ChangedFileEntry,
  ChangesAction,
  ChangesActionTarget,
  ChangesApplyResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { resetToastStore, Toaster, TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitFailure } from '../../__tests__/helpers/git-failure';
import { changedFileKey, type DraftComment, useChangesStore } from '../changes-store';
import { ChangesetDiffPane } from '../ui/changeset-diff-pane';

type LoadFileDiff = (
  path: string,
  rootId: string | null
) => Promise<BoundaryResult<StructuredFileDiff>>;
type SendComments = (drafts: readonly DraftComment[]) => boolean;
type ApplyAction = (
  action: ChangesAction,
  target: ChangesActionTarget,
  rootId: string | null
) => Promise<BoundaryResult<ChangesApplyResult>>;

function patchOf(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

/** `src/a.ts` arrives with its patch; `src/b.ts`, in another root, without. */
const WITH_PATCH: ChangedFileEntry = {
  actions: [],
  additions: 1,
  deletions: 1,
  patch: patchOf('src/a.ts'),
  path: 'src/a.ts',
  repositoryRoot: '/repo',
  revision: 'a-1',
  rootId: 'root-1',
  status: 'modified',
  worktreePath: '/repo',
};
const WITHOUT_PATCH: ChangedFileEntry = {
  ...WITH_PATCH,
  patch: null,
  path: 'src/b.ts',
  repositoryRoot: '/other',
  revision: 'b-1',
  rootId: 'root-2',
  worktreePath: '/other',
};
const FILES = [WITH_PATCH, WITHOUT_PATCH];

function draft(entry: ChangedFileEntry, id: string, text: string): DraftComment {
  return {
    comment: {
      endLine: 1,
      fileId: changedFileKey(entry),
      id,
      lines: ['new'],
      side: 'additions',
      startLine: 1,
      text,
    },
    entry,
  };
}

function fullDiff(path: string): StructuredFileDiff {
  return {
    additions: 1,
    content: { kind: 'full', newContent: 'new\n', oldContent: 'old\n', patch: patchOf(path) },
    deletions: 1,
    path,
    status: 'modified',
  };
}

const unusedLoad = vi.fn<LoadFileDiff>(() => Promise.reject(new Error('not used')));

/** The header of the file sent without its patch: it opens, and loads, on a click. */
function unloadedHeader(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /src\/b\.ts/u });
}

beforeEach(() => {
  useChangesStore.getState().reset();
  resetToastStore();
});

describe('ChangesetDiffPane', () => {
  it('renders nothing for a changeset with no files', () => {
    const { container } = render(
      <ChangesetDiffPane changesetKey="cs-1" files={[]} loadFileDiff={unusedLoad} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('heads the diff with every file in the changeset', async () => {
    render(<ChangesetDiffPane changesetKey="cs-1" files={FILES} loadFileDiff={unusedLoad} />);

    await waitFor(() => {
      expect(
        screen.getAllByTestId('diff-review-file-header').map((header) => header.textContent)
      ).toEqual([expect.stringContaining('src/a.ts'), expect.stringContaining('src/b.ts')]);
    });
  });

  it('loads a file sent without its patch from its own root when it is opened', async () => {
    const user = userEvent.setup();
    const loadFileDiff = vi.fn<LoadFileDiff>(async (path) => ({ ok: true, value: fullDiff(path) }));
    render(<ChangesetDiffPane changesetKey="cs-1" files={FILES} loadFileDiff={loadFileDiff} />);
    expect(await unloadedHeader()).toHaveAttribute('aria-expanded', 'false');

    await user.click(await unloadedHeader());

    expect(loadFileDiff).toHaveBeenCalledWith('src/b.ts', 'root-2');
    expect(
      await screen.findByRole('button', { expanded: true, name: /src\/b\.ts/u })
    ).toBeVisible();
  });

  it('says why a file could not load, and keeps the rest of the diff', async () => {
    const user = userEvent.setup();
    const loadFileDiff = vi.fn<LoadFileDiff>(async () => gitFailure('boom'));
    render(
      <>
        <ChangesetDiffPane changesetKey="cs-1" files={FILES} loadFileDiff={loadFileDiff} />
        <Toaster />
      </>
    );

    await user.click(await unloadedHeader());

    const title = await screen.findByText("Couldn't load src/b.ts");
    expect(title.parentElement).toHaveTextContent('boom');
    expect(await screen.findByRole('button', { name: /src\/a\.ts/u })).toBeVisible();
  });

  it('offers to add drafts only when there are drafts and somewhere to add them', () => {
    const onSendComments = vi.fn<SendComments>(() => true);
    const { rerender } = render(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={FILES}
        loadFileDiff={unusedLoad}
        onSendComments={onSendComments}
      />
    );
    expect(screen.queryByTestId('changeset-diff-pane-send-comments')).not.toBeInTheDocument();

    act(() => {
      useChangesStore.getState().saveComment('cs-1', draft(WITH_PATCH, 'c-1', 'Why new?'));
    });
    expect(screen.getByTestId('changeset-diff-pane-send-comments')).toHaveTextContent(
      'Add 1 comment to message'
    );

    rerender(<ChangesetDiffPane changesetKey="cs-1" files={FILES} loadFileDiff={unusedLoad} />);
    expect(screen.queryByTestId('changeset-diff-pane-send-comments')).not.toBeInTheDocument();
  });

  it("hands every draft with its file to the message, then clears this changeset's drafts", async () => {
    const user = userEvent.setup();
    const first = draft(WITH_PATCH, 'c-1', 'Why new?');
    const second = draft(WITHOUT_PATCH, 'c-2', 'And here?');
    const elsewhere = draft(WITH_PATCH, 'c-3', 'On another changeset');
    useChangesStore.getState().saveComment('cs-1', first);
    useChangesStore.getState().saveComment('cs-1', second);
    useChangesStore.getState().saveComment('cs-2', elsewhere);
    const onSendComments = vi.fn<SendComments>(() => true);
    render(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={FILES}
        loadFileDiff={unusedLoad}
        onSendComments={onSendComments}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add 2 comments to message' }));

    expect(onSendComments).toHaveBeenCalledWith([first, second]);
    expect(screen.queryByTestId('changeset-diff-pane-send-comments')).not.toBeInTheDocument();
    expect(useChangesStore.getState().commentsByChangeset.get('cs-1')).toBeUndefined();
    expect(useChangesStore.getState().commentsByChangeset.get('cs-2')).toEqual([elsewhere]);
  });

  it('still adds a draft whose file a refresh dropped from the view', async () => {
    const user = userEvent.setup();
    const gone = draft(WITHOUT_PATCH, 'c-1', 'Was this deleted on purpose?');
    useChangesStore.getState().saveComment('cs-1', gone);
    const onSendComments = vi.fn<SendComments>(() => true);
    render(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={[WITH_PATCH]}
        loadFileDiff={unusedLoad}
        onSendComments={onSendComments}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add 1 comment to message' }));

    expect(onSendComments).toHaveBeenCalledWith([gone]);
  });

  it('still offers the drafts when every file has left the view', async () => {
    const user = userEvent.setup();
    const gone = draft(WITH_PATCH, 'c-1', 'Reverted?');
    useChangesStore.getState().saveComment('cs-1', gone);
    const onSendComments = vi.fn<SendComments>(() => true);
    render(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={[]}
        loadFileDiff={unusedLoad}
        onSendComments={onSendComments}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add 1 comment to message' }));

    expect(onSendComments).toHaveBeenCalledWith([gone]);
  });

  it('keeps the drafts when they could not be added', async () => {
    const user = userEvent.setup();
    const first = draft(WITH_PATCH, 'c-1', 'Why new?');
    useChangesStore.getState().saveComment('cs-1', first);
    render(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={FILES}
        loadFileDiff={unusedLoad}
        onSendComments={() => false}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add 1 comment to message' }));

    expect(screen.getByTestId('changeset-diff-pane-send-comments')).toBeVisible();
    expect(useChangesStore.getState().commentsByChangeset.get('cs-1')).toEqual([first]);
  });
});

describe('ChangesetDiffPane actions', () => {
  const HUNK = '@@ -1 +1 @@\n-old\n+new\n';
  const applied = vi.fn<ApplyAction>(async (_action, target) => ({
    ok: true,
    value: {
      paths: target.kind === 'files' ? target.files.map((file) => file.path) : [target.path],
    },
  }));

  function offering(
    actions: readonly ChangesAction[],
    files: readonly ChangedFileEntry[] = FILES
  ): ChangedFileEntry[] {
    return files.map((entry) => ({ ...entry, actions }));
  }

  function renderActions(
    applyAction: ApplyAction = applied,
    files: readonly ChangedFileEntry[] = offering(['stage', 'revert'])
  ) {
    return render(
      <TooltipProvider>
        <ChangesetDiffPane
          applyAction={applyAction}
          changesetKey="cs-1"
          files={files}
          loadFileDiff={unusedLoad}
        />
        <Toaster />
      </TooltipProvider>
    );
  }

  /** A hunk's own button, named by its action alone. */
  function hunkButton(name: string): Promise<HTMLElement> {
    return screen.findByRole('button', { name });
  }

  beforeEach(() => {
    applied.mockClear();
  });

  it('offers nothing when no file offers an action, or nothing applies them', async () => {
    const { rerender } = render(
      <ChangesetDiffPane
        applyAction={applied}
        changesetKey="cs-1"
        files={FILES}
        loadFileDiff={unusedLoad}
      />
    );
    await screen.findByRole('button', { name: /src\/a\.ts/u });
    expect(
      screen.queryByRole('button', { name: /^(Stage|Unstage|Revert)/u })
    ).not.toBeInTheDocument();

    // The rewind preview draws the same pane with nothing to apply.
    rerender(
      <ChangesetDiffPane
        changesetKey="cs-1"
        files={offering(['stage', 'revert'])}
        loadFileDiff={unusedLoad}
      />
    );
    await screen.findByRole('button', { name: /src\/a\.ts/u });
    expect(
      screen.queryByRole('button', { name: /^(Stage|Unstage|Revert)/u })
    ).not.toBeInTheDocument();
  });

  it('stages and reverts a hunk at once, quoting it exactly', async () => {
    const user = userEvent.setup();
    renderActions();

    await user.click(await hunkButton('Stage'));
    expect(applied).toHaveBeenLastCalledWith(
      'stage',
      { hunks: [HUNK], kind: 'hunks', path: 'src/a.ts' },
      'root-1'
    );

    await user.click(await hunkButton('Revert'));
    expect(applied).toHaveBeenLastCalledWith(
      'revert',
      { hunks: [HUNK], kind: 'hunks', path: 'src/a.ts' },
      'root-1'
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('applies a file’s action from its header, naming the file as the view drew it', async () => {
    const user = userEvent.setup();
    renderActions(applied, offering(['unstage']));

    await user.click(await screen.findByRole('button', { name: 'Unstage src/b.ts' }));

    expect(applied).toHaveBeenCalledWith(
      'unstage',
      { files: [{ path: 'src/b.ts', revision: 'b-1' }], kind: 'files' },
      'root-2'
    );
  });

  it('reverts a file only once Revert is chosen in the question', async () => {
    const user = userEvent.setup();
    renderActions();
    const revertFile = await screen.findByRole('button', { name: 'Revert src/a.ts' });

    await user.click(revertFile);
    const question = await screen.findByRole('alertdialog', { name: 'Revert src/a.ts?' });
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(applied).not.toHaveBeenCalled();

    await user.click(revertFile);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revert' })
    );
    expect(applied).toHaveBeenCalledWith(
      'revert',
      { files: [{ path: 'src/a.ts', revision: 'a-1' }], kind: 'files' },
      'root-1'
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('applies each toolbar action to exactly the files that offer it, asking before it reverts them', async () => {
    const user = userEvent.setup();
    const file = (path: string, actions: readonly ChangesAction[]): ChangedFileEntry => ({
      ...WITHOUT_PATCH,
      actions,
      path,
      revision: `${path}@1`,
    });
    renderActions(applied, [
      file('src/c.ts', ['stage', 'revert']),
      file('src/d.ts', ['revert']),
      file('src/e.ts', []),
      file('src/f.ts', ['revert']),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Stage all' }));
    expect(applied).toHaveBeenLastCalledWith(
      'stage',
      { files: [{ path: 'src/c.ts', revision: 'src/c.ts@1' }], kind: 'files' },
      'root-2'
    );
    expect(screen.queryByRole('button', { name: 'Unstage all' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revert all' }));
    const question = await screen.findByRole('alertdialog', { name: 'Revert 3 files?' });
    expect(applied).toHaveBeenCalledTimes(1);
    await user.click(within(question).getByRole('button', { name: 'Revert' }));
    expect(applied).toHaveBeenLastCalledWith(
      'revert',
      {
        files: [
          { path: 'src/c.ts', revision: 'src/c.ts@1' },
          { path: 'src/d.ts', revision: 'src/d.ts@1' },
          { path: 'src/f.ts', revision: 'src/f.ts@1' },
        ],
        kind: 'files',
      },
      'root-2'
    );
  });

  it("reverts a turn's files whole, once for each folder they lie in", async () => {
    const user = userEvent.setup();
    const turnFile = (entry: ChangedFileEntry): ChangedFileEntry => ({
      ...entry,
      actions: ['revert'],
      wholeFile: true,
    });
    renderActions(applied, [turnFile(WITH_PATCH), turnFile(WITHOUT_PATCH)]);

    await screen.findByRole('button', { name: 'Revert src/a.ts' });
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revert all' }));
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Revert 2 files?' })).getByRole(
        'button',
        { name: 'Revert' }
      )
    );
    expect(applied.mock.calls).toEqual([
      ['revert', { files: [{ path: 'src/a.ts', revision: 'a-1' }], kind: 'files' }, 'root-1'],
      ['revert', { files: [{ path: 'src/b.ts', revision: 'b-1' }], kind: 'files' }, 'root-2'],
    ]);
  });

  it("says why git refused, in the host's words", async () => {
    const user = userEvent.setup();
    renderActions(async () => gitFailure('src/a.ts changed since this view was drawn.'));

    await user.click(await hunkButton('Stage'));

    const title = await screen.findByText("Couldn't stage src/a.ts");
    expect(title.parentElement).toHaveTextContent('src/a.ts changed since this view was drawn.');
  });

  it('holds every action while one runs', async () => {
    const user = userEvent.setup();
    let finish: (result: BoundaryResult<ChangesApplyResult>) => void = () => {};
    renderActions(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const controls = async () => [
      await screen.findByRole('button', { name: 'Stage all' }),
      screen.getByRole('button', { name: 'Revert all' }),
      screen.getByRole('button', { name: 'Stage src/a.ts' }),
      screen.getByRole('button', { name: 'Revert src/b.ts' }),
      await hunkButton('Stage'),
      await hunkButton('Revert'),
    ];

    await user.click(screen.getByRole('button', { name: 'Stage src/a.ts' }));
    for (const control of await controls()) {
      expect(control).toBeDisabled();
    }

    await act(async () => {
      finish({ ok: true, value: { paths: ['src/a.ts'] } });
    });
    for (const control of await controls()) {
      expect(control).toBeEnabled();
    }
  });
});
