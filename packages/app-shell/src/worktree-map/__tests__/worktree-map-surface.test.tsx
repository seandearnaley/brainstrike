import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useWorktreeMapMock = vi.fn();
vi.mock('../use-worktree-map', () => ({ useWorktreeMap: () => useWorktreeMapMock() }));

const publishMock = vi.fn();
vi.mock('../../stores/worktree-checkout-intent-store', () => ({
  useWorktreeCheckoutIntentStore: Object.assign(
    (selector: (state: { publish: unknown }) => unknown) => selector({ publish: publishMock }),
    { getState: () => ({ publish: publishMock }) }
  ),
}));

// The context the surface resolves for itself. Distinct mocks per action so a
// test can prove WHICH one ran.
const createThreadMock = vi.fn();
const selectThreadMock = vi.fn();
// (corrected at execution: the canonical surface code derives `repository`
// from `database` via `createPgliteAssistantThreadRepository` — the plan
// doc's original `createThread(resourceId)` call didn't match the real
// two-argument store action. `mockDatabase` is a controllable sentinel so one
// test can prove the guard fires when it's null, and
// `createPgliteAssistantThreadRepositoryMock` returns a DISTINCT sentinel so
// `createThread`'s call assertion stays falsifiable for BOTH arguments, not
// just the resourceId. `vi.hoisted` — not a plain top-level `const` — because
// these are referenced from a `vi.mock` factory declared further down, and
// only `vi.hoisted`-declared bindings are guaranteed initialized before a
// hoisted `vi.mock` factory can run.)
const { SENTINEL_DATABASE, SENTINEL_REPOSITORY, createPgliteAssistantThreadRepositoryMock } =
  vi.hoisted(() => {
    const sentinelDatabase = { kind: 'sentinel-database' } as const;
    const sentinelRepository = { kind: 'sentinel-repository' } as const;
    return {
      createPgliteAssistantThreadRepositoryMock: vi.fn(() => sentinelRepository),
      SENTINEL_DATABASE: sentinelDatabase,
      SENTINEL_REPOSITORY: sentinelRepository,
    };
  });
let mockDatabase: unknown = SENTINEL_DATABASE;
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => mockDatabase }));
vi.mock('../../use-active-assistant-thread-ids', () => ({
  useActiveAssistantThreadIds: () => ({ error: null, loading: false, threadIds: new Set() }),
}));
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  createPgliteAssistantThreadRepository: createPgliteAssistantThreadRepositoryMock,
  useAssistantThreadStore: (
    selector: (state: {
      createThread: typeof createThreadMock;
      selectThread: typeof selectThreadMock;
      threadsByResourceId: Record<string, readonly unknown[]>;
    }) => unknown
  ) =>
    selector({
      createThread: createThreadMock,
      selectThread: selectThreadMock,
      threadsByResourceId: {},
    }),
}));

const setIndexingMock = vi.fn();
vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  useBackgroundIndexingPreferencesStore: (
    selector: (state: { setWorktreeRootIndexingEnabled: typeof setIndexingMock }) => unknown
  ) => selector({ setWorktreeRootIndexingEnabled: setIndexingMock }),
}));

const showItemInFolderMock = vi.fn();
const openExternalMock = vi.fn();
vi.mock('../../platform-bridge', () => ({
  resolvePlatformBridge: () => ({
    openExternal: openExternalMock,
    showItemInFolder: showItemInFolderMock,
  }),
}));

const adoptMock = vi.fn();
const archiveMock = vi.fn();
vi.mock('../../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({ adopt: adoptMock, archive: archiveMock }),
}));

const addRootDirectoryByPathMock = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootDirectoryByPathMock }),
}));

import { WorktreeMapSurface } from '../worktree-map-surface';

function card(overrides: Record<string, unknown> = {}) {
  return {
    branchLabel: 'bs/bright-fox',
    createdAt: null,
    disabledReason: null,
    entry: {
      branch: 'bs/bright-fox',
      id: 'wt-1',
      managed: true,
      name: 'bright-fox',
      path: '/wt',
      primary: false,
      rootId: 'root-1',
      usable: true,
    },
    indexing: 'excluded',
    lastActivityLabel: 'Created 6 days ago',
    provenanceLabel: 'Managed',
    pullRequest: null,
    thread: null,
    ...overrides,
  };
}

const BASE_STATE = {
  error: null,
  loading: false,
  refresh: vi.fn(),
  repositories: [
    {
      cards: [card()],
      repoCommonDir: '/repo/.git',
      repositoryName: 'brainstrike',
      repositoryRoot: '/repo',
    },
  ],
  statusByPath: new Map([['/wt', { kind: 'ready', value: { ahead: 2, behind: 0, clean: false } }]]),
};

describe('WorktreeMapSurface', () => {
  beforeEach(() => {
    for (const mock of [
      addRootDirectoryByPathMock,
      adoptMock,
      archiveMock,
      createPgliteAssistantThreadRepositoryMock,
      createThreadMock,
      openExternalMock,
      publishMock,
      selectThreadMock,
      setIndexingMock,
      showItemInFolderMock,
    ]) {
      mock.mockReset();
    }
    createPgliteAssistantThreadRepositoryMock.mockReturnValue(SENTINEL_REPOSITORY);
    mockDatabase = SENTINEL_DATABASE;
    addRootDirectoryByPathMock.mockResolvedValue({ kind: 'directory', name: 'wt' });
    adoptMock.mockResolvedValue({ ok: true, value: {} });
    archiveMock.mockResolvedValue({ ok: true, value: {} });
    createThreadMock.mockResolvedValue({ id: 'thread-9' });
    useWorktreeMapMock.mockReset().mockReturnValue(BASE_STATE);
  });

  it('renders one section per repository and one card per checkout', () => {
    render(<WorktreeMapSurface />);

    expect(screen.getByRole('heading', { name: 'brainstrike' })).toBeInTheDocument();
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('bs/bright-fox')).toBeInTheDocument();
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('shows dirty and ahead glyphs from the per-card status, never before it resolves', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'loading' }]]),
    });
    const { rerender } = render(<WorktreeMapSurface />);
    expect(screen.getByText('checking…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();

    useWorktreeMapMock.mockReturnValue(BASE_STATE);
    rerender(<WorktreeMapSurface />);
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByLabelText('2 commits ahead of upstream')).toBeInTheDocument();
  });

  it('states a per-card status failure instead of a clean glyph', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'error', message: 'fatal: not a git repository' }]]),
    });
    render(<WorktreeMapSurface />);

    expect(screen.getByText('status unavailable: fatal: not a git repository')).toBeInTheDocument();
  });

  it('renders an unusable card present-but-disabled with its stated reason', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              disabledReason: 'Locked: rebase in progress',
              entry: { ...card().entry, usable: false },
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    expect(screen.getByText('Locked: rebase in progress')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-map-new-thread')).toBeDisabled();
  });

  it('states a list failure instead of rendering an empty map', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      error: 'The worktree service is not available in this session.',
      repositories: [],
    });
    render(<WorktreeMapSurface />);

    expect(
      screen.getByText('The worktree service is not available in this session.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No worktrees yet')).not.toBeInTheDocument();
  });

  it('shows the empty state only when the list genuinely came back empty', () => {
    useWorktreeMapMock.mockReturnValue({ ...BASE_STATE, repositories: [] });
    render(<WorktreeMapSurface />);

    expect(
      screen.getByText("No worktrees yet — create one from the composer's Mode chip.")
    ).toBeInTheDocument();
  });

  it('creates a thread, selects it, and publishes the checkout intent for THAT thread id', async () => {
    createThreadMock.mockResolvedValue({ id: 'thread-9' });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    expect(createThreadMock).toHaveBeenCalledTimes(1);
    // Falsifiable for BOTH arguments: `SENTINEL_REPOSITORY` proves the real
    // repository (derived from `database` via
    // `createPgliteAssistantThreadRepository`) is what's threaded through,
    // not `expect.anything()` standing in for an unverified first argument.
    expect(createThreadMock).toHaveBeenCalledWith(SENTINEL_REPOSITORY, 'brainstrike:workspace');
    expect(selectThreadMock).toHaveBeenCalledTimes(1);
    expect(selectThreadMock).toHaveBeenCalledWith('brainstrike:workspace', 'thread-9');
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-9',
      worktreeId: 'wt-1',
    });
    // Falsifier: the Map must not reach for any other seam to do this.
    expect(setIndexingMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('states a loud error and never calls createThread when the workspace database is not ready', async () => {
    // (corrected at execution: onNewThread's repository guard, added beside
    // the existing !worktreeId guard, must fail LOUD — a stated actionError,
    // never a silent return — and createThread must never be reached.)
    mockDatabase = null;
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText(
      'Starting a new thread is unavailable until the workspace database is ready.'
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes no intent and states the failure when thread creation fails', async () => {
    createThreadMock.mockRejectedValue(new Error('database unavailable'));
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText('database unavailable');
    expect(publishMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
  });

  it('toggles indexing through the durable-root setter, never the adapter-keyed one', async () => {
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByRole('button', { name: /not indexed/iu }));

    expect(setIndexingMock).toHaveBeenCalledTimes(1);
    expect(setIndexingMock).toHaveBeenCalledWith('root-1', true);
  });

  // These two pin the destructive/rooting seams so the surface cannot ship
  // with the handlers stubbed (plan-review R2): each asserts the CALL and its
  // exact argument, which no `setActionError(null)` stub can satisfy.
  it('archives through the worktrees bridge with the card worktree id and states a refusal verbatim', async () => {
    archiveMock.mockResolvedValue({ error: 'worktree has uncommitted changes', ok: false });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive/iu }));

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith({ worktreeId: 'wt-1' });
    await screen.findByText('Worktree not archived: worktree has uncommitted changes');
  });

  it('adds the checkout as a workspace root through the by-path seam', async () => {
    // (corrected at execution: the canonical fixture's shared `card()`
    // default is `rootId: 'root-1'` — already a mounted root, so the card
    // correctly never offers "Add as root" for it. This is the ONE test that
    // exercises the unmounted case; every other test keeps the shared
    // default.)
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, rootId: null } })],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /add as root/iu }));

    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    // Falsifier: adding a root never archives or mutates indexing.
    expect(archiveMock).not.toHaveBeenCalled();
    expect(setIndexingMock).not.toHaveBeenCalled();
  });

  // An unmanaged card offers Adopt as its own ENABLED action (never a
  // disabled "coming soon" stub — A1/A7), and this is the FIRST real UI
  // caller of `worktrees.adopt`: Task 2 shipped the bridge method, but the
  // Mode chip picker's own planned call was unreachable and removed.
  it('adopts through the worktrees bridge with the card path, refreshes on success', async () => {
    const refreshMock = vi.fn();
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              disabledReason:
                'Created outside BrainStrike — adopting it is coming with the Worktree Map.',
              entry: { ...card().entry, id: null, managed: false, usable: false },
              provenanceLabel: 'External',
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /adopt/iu }));

    expect(adoptMock).toHaveBeenCalledTimes(1);
    expect(adoptMock).toHaveBeenCalledWith({ createdBy: 'user', path: '/wt' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // Falsifier: adopting never archives or adds a root.
    expect(archiveMock).not.toHaveBeenCalled();
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
  });

  it('states an adoption refusal verbatim and does not refresh', async () => {
    const refreshMock = vi.fn();
    adoptMock.mockResolvedValue({
      error:
        'The worktree at "/wt" is outside every open folder. Grant access to its folder first, then adopt it.',
      ok: false,
    });
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, id: null, managed: false, usable: false } })],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /adopt/iu }));

    await screen.findByText(
      'Could not adopt "bright-fox": The worktree at "/wt" is outside every open folder. Grant access to its folder first, then adopt it.'
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // TRIPWIRE (coordinator ruling, 2026-08-26). W3's A6 ruling deferred the
  // terminal-session seam to W6 and recorded "absent, not stubbed"; W5's Map
  // is exactly where a well-meaning edit would reintroduce it, because spec
  // §10 lists the action. This test states the omission as a CONTRACT so the
  // ruling cannot be quietly reversed: the item must not appear in any form —
  // enabled, disabled, or "coming soon". When W6 lands the terminal seam, this
  // test is DELETED in that PR, not weakened here.
  it('offers no "Open in Terminal" action anywhere on a card (W6 owns the seam)', async () => {
    render(<WorktreeMapSurface />);
    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByText(/open in terminal/iu)).not.toBeInTheDocument();
    // Also assert the DISABLED shape is absent: a disabled stub would satisfy
    // a naive queryByRole({ name, disabled: false }) check while still being
    // the exact thing the ruling forbids.
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
  });
});
