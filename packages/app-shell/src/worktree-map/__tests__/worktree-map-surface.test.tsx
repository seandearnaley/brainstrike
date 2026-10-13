import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useWorktreeMapMock = vi.fn();
vi.mock('../use-worktree-map', () => ({ useWorktreeMap: () => useWorktreeMapMock() }));

const publishMock = vi.fn();
vi.mock('../../stores/worktree-checkout-intent-store', () => ({
  useWorktreeCheckoutIntentStore: Object.assign(
    (selector: (state: { publish: unknown }) => unknown) => selector({ publish: publishMock }),
    { getState: () => ({ publish: publishMock }) }
  ),
}));

const openTerminalAtMock = vi.fn();
vi.mock('../../stores/terminal-target-store', () => ({
  useTerminalTargetStore: Object.assign(
    (selector: (state: { openTerminalAt: unknown }) => unknown) =>
      selector({ openTerminalAt: openTerminalAtMock }),
    { getState: () => ({ openTerminalAt: openTerminalAtMock }) }
  ),
}));

let mockTerminalAvailable = true;
vi.mock('../../terminal-panel/terminal-bridge', () => ({
  isTerminalBridgeAvailable: () => mockTerminalAvailable,
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
// (bot review fix, PR #2664) Controllable so a test can prove the hand-off
// item only renders for the card whose thread IS the selected thread.
let mockSelectedThreadByResourceId: Record<string, string> = {};
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  createPgliteAssistantThreadRepository: createPgliteAssistantThreadRepositoryMock,
  useAssistantThreadStore: (
    selector: (state: {
      createThread: typeof createThreadMock;
      selectedThreadByResourceId: Record<string, string>;
      selectThread: typeof selectThreadMock;
      threadsByResourceId: Record<string, readonly unknown[]>;
    }) => unknown
  ) =>
    selector({
      createThread: createThreadMock,
      selectedThreadByResourceId: mockSelectedThreadByResourceId,
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
const inspectArchiveMock = vi.fn();
vi.mock('../../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: adoptMock,
    archive: archiveMock,
    inspectArchive: inspectArchiveMock,
  }),
}));

const addRootDirectoryByPathMock = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootDirectoryByPathMock }),
}));

import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../../assistant-thread-host-context';
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

// Keep Radix's deferred close autofocus inside this fixture's jsdom lifetime.
afterEach(async () => {
  const menu = screen.queryByRole('menu');
  if (!menu) {
    return;
  }
  const triggerId = menu.getAttribute('aria-labelledby');
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  if (!trigger) {
    throw new Error('The open worktree card menu must identify its focus-return trigger.');
  }
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
});

describe('WorktreeMapSurface', () => {
  beforeEach(() => {
    for (const mock of [
      addRootDirectoryByPathMock,
      adoptMock,
      archiveMock,
      inspectArchiveMock,
      createPgliteAssistantThreadRepositoryMock,
      createThreadMock,
      openExternalMock,
      openTerminalAtMock,
      publishMock,
      selectThreadMock,
      setIndexingMock,
      showItemInFolderMock,
    ]) {
      mock.mockReset();
    }
    createPgliteAssistantThreadRepositoryMock.mockReturnValue(SENTINEL_REPOSITORY);
    mockDatabase = SENTINEL_DATABASE;
    mockSelectedThreadByResourceId = {};
    mockTerminalAvailable = true;
    addRootDirectoryByPathMock.mockResolvedValue({ kind: 'directory', name: 'wt' });
    adoptMock.mockResolvedValue({ ok: true, value: {} });
    archiveMock.mockResolvedValue({ ok: true, value: {} });
    inspectArchiveMock.mockResolvedValue({
      ok: true,
      value: {
        confirmationToken: null,
        ignoredEntryCount: 0,
        ignoredTopLevelEntries: [],
        ignoredTopLevelEntriesTruncated: false,
        ignoredTopLevelEntryCount: 0,
      },
    });
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

  it('searches checkout metadata locally and clears a no-match result', async () => {
    const user = userEvent.setup();
    render(<WorktreeMapSurface />);
    const search = screen.getByRole('searchbox', { name: 'Search worktrees' });
    await user.type(search, 'BRAINSTRIKE bright');
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    await user.type(search, ' absent');
    expect(screen.queryByTestId('worktree-map-card')).not.toBeInTheDocument();
    expect(screen.getByText('No matching worktrees')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
  });

  it('bounds large collections and resets the page when searching', async () => {
    const user = userEvent.setup();
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: Array.from({ length: 61 }, (_, i) =>
            card({
              entry: {
                ...card().entry,
                name: `checkout-${String(i).padStart(2, '0')}`,
                path: `/wt/${i}`,
              },
            })
          ),
        },
      ],
    });
    render(<WorktreeMapSurface />);
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    const lane = screen.getAllByTestId('worktree-map-card')[0]?.parentElement;
    if (!lane) {
      throw new Error('Missing checkout container');
    }
    lane.scrollLeft = 600;
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getAllByTestId('worktree-map-card')[0]?.parentElement?.scrollLeft).toBe(0);
    expect(screen.getByText('26–50 of 61')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search worktrees' }), 'checkout-60');
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
  });

  it('keeps the clamped page when attention results recover after a refresh', async () => {
    const user = userEvent.setup();
    const cards = Array.from({ length: 51 }, (_, i) =>
      card({ entry: { ...card().entry, name: `checkout-${i}`, path: `/wt/${i}` } })
    );
    const state = {
      ...BASE_STATE,
      repositories: [{ ...BASE_STATE.repositories[0], cards }],
      statusByPath: new Map(
        cards.map((item) => [
          item.entry.path,
          {
            kind: 'ready',
            value: { ahead: 0, behind: 0, clean: false },
          },
        ])
      ),
    };
    useWorktreeMapMock.mockReturnValue(state);
    const view = render(<WorktreeMapSurface />);
    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('51–51 of 51')).toBeInTheDocument();
    const scrollport = screen
      .getAllByTestId('worktree-map-card')[0]
      ?.closest('section')?.parentElement;
    if (!scrollport) {
      throw new Error('Missing worktree scrollport');
    }
    scrollport.scrollTop = 500;
    useWorktreeMapMock.mockReturnValue({ ...state, statusByPath: new Map() });
    view.rerender(<WorktreeMapSurface />);
    expect(screen.getByText('No matching worktrees')).toBeInTheDocument();
    useWorktreeMapMock.mockReturnValue(state);
    view.rerender(<WorktreeMapSurface />);
    expect(screen.getByText('1–25 of 51')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('worktree-map-card')[0]?.closest('section')?.parentElement?.scrollTop
    ).toBe(0);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('filters known attention states without treating primary or unknown status as broken', async () => {
    const user = userEvent.setup();
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card(),
            card({
              entry: {
                ...card().entry,
                name: 'primary',
                path: '/primary',
                primary: true,
                usable: false,
              },
            }),
            card({ entry: { ...card().entry, name: 'checking', path: '/checking' } }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);
    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('bright-fox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Running' }));
    expect(screen.getByText('No matching worktrees')).toBeInTheDocument();
  });

  it('shows checkout paths and explicit clean status on named rows', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      statusByPath: new Map([
        ['/wt', { kind: 'ready', value: { ahead: null, behind: null, clean: true } }],
      ]),
    });
    render(<WorktreeMapSurface />);
    expect(screen.getByRole('article', { name: 'bright-fox' })).toBeInTheDocument();
    expect(screen.getByText('/wt')).toBeInTheDocument();
    expect(screen.getByText('Clean')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not indexed' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('states that ghost checkouts are missing instead of checking forever', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, provenance: 'agent-reported' } })],
        },
      ],
      statusByPath: new Map(),
    });
    render(<WorktreeMapSurface />);
    expect(screen.getByText('Not on disk')).toBeInTheDocument();
    expect(screen.queryByText('checking…')).not.toBeInTheDocument();
  });

  it('opens the linked thread directly and identifies the current running checkout', async () => {
    const thread = {
      running: true,
      threadId: 'current-thread',
      title: 'Improve collection navigation',
    };
    mockSelectedThreadByResourceId = { 'brainstrike:workspace': thread.threadId };
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [{ ...BASE_STATE.repositories[0], cards: [card({ thread })] }],
    });
    render(<WorktreeMapSurface />);
    expect(screen.getByText('Current thread')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Improve collection navigation/u }));
    expect(selectThreadMock).toHaveBeenCalledWith('brainstrike:workspace', 'current-thread');
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

    // BST-1392 W5 e2e finding: Adopt only inserts the ledger row, it never
    // mounts a `roots` row, and use-workspace-bar.ts's bind waits up to 5s
    // for one and then fails ("no unique live workspace identity") — so
    // "New thread here" must mount BEFORE creating/selecting/publishing,
    // exactly like use-worktree-mode.ts's mountWorktree/onSelectExisting do.
    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
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

  it('creates the thread through the host owner in committed mode, never the history repository', async () => {
    const hostCreate = vi.fn(async (resourceId: string) => ({
      createdAt: new Date('2026-10-08T00:00:00.000Z'),
      id: 'host-thread-7',
      resourceId,
      title: 'New Thread',
      updatedAt: new Date('2026-10-08T00:00:00.000Z'),
    }));
    const host: AssistantThreadHostCapability = {
      createThread: hostCreate,
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      ownsThread: vi.fn(),
      renameThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(),
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    // The store action creates through whatever repository it is handed.
    createThreadMock.mockImplementation(
      (repository: { createThread: (resourceId: string) => Promise<{ id: string }> }, resourceId) =>
        repository.createThread(resourceId)
    );
    render(
      <AssistantThreadHostContext.Provider value={host}>
        <WorktreeMapSurface />
      </AssistantThreadHostContext.Provider>
    );

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await waitFor(() => expect(publishMock).toHaveBeenCalledTimes(1));
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    expect(hostCreate).toHaveBeenCalledExactlyOnceWith('brainstrike:workspace');
    expect(createThreadMock.mock.calls[0]?.[0]).not.toBe(SENTINEL_REPOSITORY);
    expect(selectThreadMock).toHaveBeenCalledWith('brainstrike:workspace', 'host-thread-7');
    expect(publishMock).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'host-thread-7',
      worktreeId: 'wt-1',
    });
  });

  // PIN (PR #2671 review ruling): the mount callbacks must NOT call the Map's
  // own `refresh()`. A refresh fired when the mount promise resolves races the
  // `roots` write — the row lands later, in the fire-and-forget mid-session
  // registration — so it usually re-reads `rootId: null` and the card stays
  // badge-less anyway. The deterministic re-read lives in `useWorktreeMap`
  // itself, keyed on the root-identity context republishing after the row is
  // written (see use-worktree-map.test.ts). Reintroducing a caller-side
  // refresh here would only paper over that ordering.
  it('does not refresh from onNewThread — the Map re-loads via the root-identity subscription', async () => {
    const refreshMock = vi.fn();
    useWorktreeMapMock.mockReturnValue({ ...BASE_STATE, refresh: refreshMock });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('states a failure and never creates a thread when mounting the checkout as a root fails', async () => {
    addRootDirectoryByPathMock.mockResolvedValueOnce(null);
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText('Could not add "bright-fox" as a workspace root.');
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('states the real remedy, not the generic "Add Folder" copy, when an adopted checkout is refused as unreachable', async () => {
    // BST-1392 follow-up: the picker-less mount grant now covers every
    // adopted checkout the app can REACH (a live ledger row under the managed
    // directory OR inside a granted root — `isAuthorizedWorktreeMountPath`,
    // worktree-adopt.ts), so an adopted card (`worktreeId` non-null, or this
    // callback couldn't even be reached) can only see the generic "never
    // granted" refusal when the checkout is OUTSIDE every open folder and the
    // managed directory both — e.g. its granting root was disconnected after
    // adoption. The generic refusal text is reused VERBATIM here on purpose —
    // it is the actual string `resolveGrantedRootHandle` throws
    // (`workspace-recent-roots.ts`'s `NEVER_GRANTED_MESSAGE`), duplicated
    // rather than imported since `apps/desktop` isn't a dependency this
    // package can reach.
    addRootDirectoryByPathMock.mockRejectedValueOnce(
      new Error('Folder was never granted in this app; use Add Folder to grant it.')
    );
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText(
      '"bright-fox" was adopted, but BrainStrike couldn\'t confirm it\'s inside an open folder or its managed worktrees folder, so it can\'t be mounted automatically. Use the workspace bar\'s "Add Folder" to grant this worktree\'s folder directly, then try "New thread here" again.'
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('passes an UNRELATED addRootDirectoryByPath failure through verbatim, not the managed-worktree remedy', async () => {
    addRootDirectoryByPathMock.mockRejectedValueOnce(new Error('disk is full'));
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText('disk is full');
    expect(createThreadMock).not.toHaveBeenCalled();
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

  // (bot review fix, PR #2664) onHandOffToLocal was never passed to any
  // card, so "Hand off to Local" never rendered and the null-worktree
  // checkout-intent path (`use-workspace-bar-mode.ts`'s
  // `intent.worktreeId ? onSelectWorktree(...) : onHandOffToLocal()`) was
  // dead. These three pin: present + publishes on the selected-and-bound
  // card, absent on a differently-bound card, absent with no selection.
  it('shows Hand off to Local on the card bound to the selected thread, and publishes the hand-off intent', async () => {
    mockSelectedThreadByResourceId = { 'brainstrike:workspace': 'thread-selected' };
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              thread: {
                running: false,
                threadId: 'thread-selected',
                title: 'Selected',
                updatedAt: null,
              },
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /hand off to local/iu }));

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-selected',
      worktreeId: null,
    });
  });

  it('does not show Hand off to Local on a card bound to a thread OTHER than the selected one', async () => {
    mockSelectedThreadByResourceId = { 'brainstrike:workspace': 'thread-selected' };
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              thread: {
                running: false,
                threadId: 'thread-not-selected',
                title: 'Not selected',
                updatedAt: null,
              },
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /hand off to local/iu })).not.toBeInTheDocument();
  });

  it('does not show Hand off to Local anywhere when no thread is selected', async () => {
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /hand off to local/iu })).not.toBeInTheDocument();
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
    const refreshMock = vi.fn();
    archiveMock.mockResolvedValue({ error: 'worktree has uncommitted changes', ok: false });
    useWorktreeMapMock.mockReturnValue({ ...BASE_STATE, refresh: refreshMock });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive/iu }));

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith({ worktreeId: 'wt-1' });
    await screen.findByText('Worktree not archived: worktree has uncommitted changes');
    // A refused archive changed nothing to re-read.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // PR #2671 review note 2: with adopt refreshing, archive was the one
  // remaining ledger mutation that left its own stale card on screen (the
  // removed checkout) until an unrelated invalidation. Unlike the mount
  // paths, the archive IPC resolves only after the ledger row is archived,
  // so a caller-side refresh here observes a write that already happened —
  // the mount-path race does not apply.
  it('refreshes the Map after a successful archive so the removed card leaves the list', async () => {
    const refreshMock = vi.fn();
    useWorktreeMapMock.mockReturnValue({ ...BASE_STATE, refresh: refreshMock });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive/iu }));

    expect(archiveMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it('shows ignored paths and archives only after destructive confirmation', async () => {
    inspectArchiveMock.mockResolvedValueOnce({
      ok: true,
      value: {
        confirmationToken: 'ignored-token',
        ignoredEntryCount: 17,
        ignoredTopLevelEntries: [
          '.env',
          '.secret-01',
          '.secret-02',
          '.secret-03',
          '.secret-04',
          '.secret-05',
          '.secret-06',
          '.secret-07',
          '.secret-08',
          'data/',
        ],
        ignoredTopLevelEntriesTruncated: true,
        ignoredTopLevelEntryCount: 12,
      },
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive/iu }));

    expect(archiveMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/permanently delete 17 ignored entries/iu)).toBeInTheDocument();
    expect(screen.getByText('.env')).toBeInTheDocument();
    expect(screen.getByText('data/')).toBeInTheDocument();
    expect(screen.getByText('2 additional top-level paths are hidden.')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /delete ignored files and archive/iu })
    );
    expect(archiveMock).toHaveBeenCalledWith({
      confirmIgnoredEntries: 'ignored-token',
      worktreeId: 'wt-1',
    });
  });

  it('adds the checkout as a workspace root through the by-path seam', async () => {
    // (corrected at execution: the canonical fixture's shared `card()`
    // default is `rootId: 'root-1'` — already a mounted root, so the card
    // correctly never offers "Add as root" for it. This is the ONE test that
    // exercises the unmounted case; every other test keeps the shared
    // default.)
    const refreshMock = vi.fn();
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      refresh: refreshMock,
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
    // Same pin as onNewThread above: no caller-side refresh — the Map
    // re-loads via the root-identity subscription once the row exists.
    expect(refreshMock).not.toHaveBeenCalled();
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

  // (bot review fix, PR #2664) The service unconditionally refuses adopting
  // a repository's primary checkout, so offering Adopt on a primary card was
  // a guaranteed error. Role-absent — not disabled, not present in any form;
  // the same idiom the Add-as-root/Open-in-Terminal complementary pair uses
  // below (BST-1457 replaced the old W6 tripwire this used to point at).
  it('offers no Adopt action on a primary, unmanaged card (the service always refuses it)', async () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              entry: { ...card().entry, id: null, managed: false, primary: true, usable: false },
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /^adopt$/iu })).not.toBeInTheDocument();
  });

  it('opens the pinned terminal for a card that is inside an open folder', async () => {
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /open in terminal/iu }));

    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/wt',
      rootId: 'root-1',
    });
    // Falsifier: opening a terminal is not a ledger mutation and not a mount.
    expect(adoptMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('offers Add as root instead of Open in Terminal for a checkout outside every open folder', async () => {
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

    // Complementary, never both, never a disabled stub: the menu always names
    // the next step.
    expect(screen.getByRole('menuitem', { name: /add as root/iu })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
  });

  it('omits Open in Terminal entirely when the platform has no terminal bridge', async () => {
    mockTerminalAvailable = false;
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    // Capability gating by omission (spec §12): web renders no item, not a
    // disabled one. Reveal still renders, proving the menu itself is fine.
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /reveal/iu })).toBeInTheDocument();
  });

  describe('card menu fixture lifetime', () => {
    let restoredFocus = false;

    afterAll(() => {
      expect(restoredFocus).toBe(true);
    });

    it('finishes focus restoration when a test leaves a card menu open', async () => {
      render(<WorktreeMapSurface />);
      const trigger = screen.getByTestId('worktree-map-card-actions');
      await userEvent.click(trigger);
      expect(screen.getByRole('menu')).toBeVisible();
      expect(trigger).not.toHaveFocus();
      trigger.addEventListener(
        'focus',
        () => {
          restoredFocus = true;
        },
        { once: true }
      );
      // The registered fixture teardown must close the real menu.
    });
  });
});
