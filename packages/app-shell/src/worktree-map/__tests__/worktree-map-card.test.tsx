import type { WorktreeListEntry } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeMapCard } from '../worktree-map-card';
import { buildWorktreeMap } from '../worktree-map-model';

const MOUNTED_WORKTREE: WorktreeListEntry = {
  branch: 'bs/bright-fox',
  containment: ['root-1'],
  createdAt: null,
  detached: false,
  disabledReason: null,
  externalTool: null,
  id: 'wt-1',
  lockedReason: null,
  managed: true,
  name: 'bright-fox',
  path: '/wt',
  primary: false,
  provenance: 'scanned',
  remedy: null,
  repoCommonDir: '/repo/.git',
  repositoryRoot: '/repo',
  rootId: 'root-1',
  rootIdIsExactMount: true,
  setupReason: null,
  setupStatus: 'none',
  trust: 'validated',
  trustReason: null,
  usable: true,
};

/** The card for a mounted worktree, given Main's worktree choices (null until read). */
function renderCard(
  indexingOptInByRootId: Readonly<Record<string, boolean>> | null,
  indexedRootIds: readonly string[] | null = []
) {
  const card = buildWorktreeMap({
    entries: [MOUNTED_WORKTREE],
    indexedRootIds,
    indexingOptInByRootId,
    prCache: new Map(),
    runningThreadIds: new Set(),
    threads: [],
  })[0]?.cards[0];
  if (!card) {
    throw new Error('The worktree map dropped the mounted worktree.');
  }
  render(
    <WorktreeMapCard
      card={card}
      onAddAsRoot={vi.fn()}
      onAdopt={vi.fn()}
      onArchive={vi.fn()}
      onNewThread={vi.fn()}
      onOpenPullRequest={vi.fn()}
      onOpenTerminal={undefined}
      onOpenThread={vi.fn()}
      onReveal={vi.fn()}
      onToggleIndexing={vi.fn()}
      status={undefined}
    />
  );
}

describe('WorktreeMapCard indexing toggle', () => {
  it('makes no indexing claim before Main’s config is read', () => {
    renderCard(null);
    expect(screen.getByTestId('worktree-map-card')).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-map-indexing')).not.toBeInTheDocument();
    expect(screen.queryByText(/not indexed|indexing enabled/iu)).not.toBeInTheDocument();
  });

  it.each([
    [{}, 'Not indexed'],
    [{ 'root-1': false }, 'Not indexed'],
    [{ 'root-1': true }, 'Indexing enabled'],
  ] as const)('states Main’s choice %o as %s', (choices, label) => {
    renderCard(choices);
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('shows a checkout open as an ordinary folder as indexed, with no toggle claiming to control it', () => {
    renderCard({}, ['root-1']);
    expect(screen.queryByRole('button', { name: /not indexed|indexing enabled/iu })).toBeNull();
    expect(screen.getByRole('img', { name: 'Indexed as an open folder' })).toHaveAttribute(
      'title',
      'Indexed: this checkout is open as a folder in the Explorer, so this map does not control it.'
    );
  });
});
