import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChangedFileEntry, StructuredFileDiff } from '@brainstrike/types';
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  additions: 1,
  deletions: 1,
  patch: patchOf('src/a.ts'),
  path: 'src/a.ts',
  repositoryRoot: '/repo',
  revertible: true,
  rootId: 'root-1',
  status: 'modified',
  worktreePath: '/repo',
};
const WITHOUT_PATCH: ChangedFileEntry = {
  ...WITH_PATCH,
  patch: null,
  path: 'src/b.ts',
  repositoryRoot: '/other',
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
