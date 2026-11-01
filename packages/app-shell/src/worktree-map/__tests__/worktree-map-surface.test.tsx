import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitFailure } from '../../__tests__/helpers/git-failure';
import {
  stubWorktreesBridge,
  workspaceGitWrapper,
} from '../../__tests__/helpers/workspace-git-services-wrapper';
import { TerminalHost } from '../../__tests__/helpers/workspace-terminal-services-wrapper';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../../assistant-thread-host-context';
import { WorktreeMapSurface } from '../worktree-map-surface';

// A store, so a new map state re-renders the surface as the real hook does.
const useMapState = await vi.hoisted(async () =>
  (await import('zustand')).create<{ readonly value: unknown }>(() => ({ value: undefined }))
);
vi.mock('../use-worktree-map', () => ({ useWorktreeMap: () => useMapState((s) => s.value) }));
function setWorktreeMap(value: unknown): void {
  act(() => useMapState.setState({ value }));
}

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

// The context the surface resolves for itself. Distinct mocks per action so a
// test can prove WHICH one ran.
const createThreadMock = vi.fn();
const selectThreadMock = vi.fn();
// (bot review fix, PR #2664) Controllable so a test can prove the hand-off
// item only renders for the card whose thread IS the selected thread.
let mockSelectedThreadByResourceId: Record<string, string> = {};
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
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
/** The host serving the worktrees bridge, as the desktop shell provides it. */
const WorktreesHost = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    adopt: adoptMock,
    archive: archiveMock,
    inspectArchive: inspectArchiveMock,
  }),
});

const addRootDirectoryByPathMock = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootDirectoryByPathMock }),
}));

/** The surface as the desktop shell mounts it: an agent host owns the threads. */
function Surface() {
  const host = useMemo<AssistantThreadHostCapability>(
    () => ({
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      ownsThread: vi.fn(),
      renameThread: vi.fn(),
      renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(),
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    }),
    []
  );
  return (
    <WorktreesHost>
      <TerminalHost>
        <AssistantThreadHostContext.Provider value={host}>
          <WorktreeMapSurface />
        </AssistantThreadHostContext.Provider>
      </TerminalHost>
    </WorktreesHost>
  );
}

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
    lastActivityLabel: 'Created 6 days ago',
    provenanceLabel: 'Managed',
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
      createThreadMock,
      openExternalMock,
      openTerminalAtMock,
      publishMock,
      selectThreadMock,
      showItemInFolderMock,
    ]) {
      mock.mockReset();
    }
    mockSelectedThreadByResourceId = {};
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
    setWorktreeMap(BASE_STATE);
  });

  it('renders one section per repository and one card per checkout', () => {
    render(<Surface />);

    expect(screen.getByRole('heading', { name: 'brainstrike' })).toBeInTheDocument();
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('bs/bright-fox')).toBeInTheDocument();
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('searches checkout metadata locally and clears a no-match result', async () => {
    const user = userEvent.setup();
    render(<Surface />);
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
    setWorktreeMap({
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
    render(<Surface />);
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
    setWorktreeMap(state);
    render(<Surface />);
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
    setWorktreeMap({ ...state, statusByPath: new Map() });
    expect(screen.getByText('No matching worktrees')).toBeInTheDocument();
    setWorktreeMap(state);
    expect(screen.getByText('1–25 of 51')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('worktree-map-card')[0]?.closest('section')?.parentElement?.scrollTop
    ).toBe(0);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('filters known attention states without treating primary or unknown status as broken', async () => {
    const user = userEvent.setup();
    setWorktreeMap({
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
    render(<Surface />);
    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('bright-fox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Running' }));
    expect(screen.getByText('No matching worktrees')).toBeInTheDocument();
  });

  it('shows checkout paths and explicit clean status on named rows', () => {
    setWorktreeMap({
      ...BASE_STATE,
      statusByPath: new Map([
        ['/wt', { kind: 'ready', value: { ahead: null, behind: null, clean: true } }],
      ]),
    });
    render(<Surface />);
    expect(screen.getByRole('article', { name: 'bright-fox' })).toBeInTheDocument();
    expect(screen.getByText('/wt')).toBeInTheDocument();
    expect(screen.getByText('Clean')).toBeInTheDocument();
  });

  it('states that ghost checkouts are missing instead of checking forever', () => {
    setWorktreeMap({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, provenance: 'agent-reported' } })],
        },
      ],
      statusByPath: new Map(),
    });
    render(<Surface />);
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
    setWorktreeMap({
      ...BASE_STATE,
      repositories: [{ ...BASE_STATE.repositories[0], cards: [card({ thread })] }],
    });
    render(<Surface />);
    expect(screen.getByText('Current thread')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Improve collection navigation/u }));
    expect(selectThreadMock).toHaveBeenCalledWith('brainstrike:workspace', 'current-thread');
  });

  it('shows dirty and ahead glyphs from the per-card status, never before it resolves', () => {
    setWorktreeMap({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'loading' }]]),
    });
    render(<Surface />);
    expect(screen.getByText('checking…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();

    setWorktreeMap(BASE_STATE);
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByLabelText('2 commits ahead of upstream')).toBeInTheDocument();
  });

  it('states a per-card status failure instead of a clean glyph', () => {
    setWorktreeMap({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'error', message: 'fatal: not a git repository' }]]),
    });
    render(<Surface />);

    expect(screen.getByText('status unavailable: fatal: not a git repository')).toBeInTheDocument();
  });

  it('renders an unusable card present-but-disabled with its stated reason', () => {
    setWorktreeMap({
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
    render(<Surface />);

    expect(screen.getByText('Locked: rebase in progress')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-map-new-thread')).toBeDisabled();
  });

  it('states a list failure instead of rendering an empty map', () => {
    setWorktreeMap({
      ...BASE_STATE,
      error: 'The worktree service is not available in this session.',
      repositories: [],
    });
    render(<Surface />);

    expect(
      screen.getByText('The worktree service is not available in this session.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No worktrees yet')).not.toBeInTheDocument();
  });

  it('shows the empty state only when the list genuinely came back empty', () => {
    setWorktreeMap({ ...BASE_STATE, repositories: [] });
    render(<Surface />);

    expect(
      screen.getByText("No worktrees yet — create one from the composer's Mode chip.")
    ).toBeInTheDocument();
  });

  it('creates a thread, selects it, and publishes the checkout intent for THAT thread id', async () => {
    createThreadMock.mockResolvedValue({ id: 'thread-9' });
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    // BST-1392 W5 e2e finding: Adopt only inserts the ledger row, it never
    // mounts a `roots` row, and use-workspace-bar.ts's bind waits up to 5s
    // for one and then fails ("no unique live workspace identity") — so
    // "New thread here" must mount BEFORE creating/selecting/publishing,
    // exactly like use-worktree-mode.ts's mountWorktree/onSelectExisting do.
    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    expect(createThreadMock).toHaveBeenCalledTimes(1);
    // The host-owned catalog repository is what's threaded through.
    expect(createThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ createThread: expect.any(Function) }),
      'brainstrike:workspace'
    );
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
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('creates the thread through the host owner', async () => {
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
      renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
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
      </AssistantThreadHostContext.Provider>,
      { wrapper: WorktreesHost }
    );

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await waitFor(() => expect(publishMock).toHaveBeenCalledTimes(1));
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    expect(hostCreate).toHaveBeenCalledExactlyOnceWith('brainstrike:workspace');
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
    setWorktreeMap({ ...BASE_STATE, refresh: refreshMock });
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('states a failure and never creates a thread when mounting the checkout as a root fails', async () => {
    addRootDirectoryByPathMock.mockResolvedValueOnce(null);
    render(<Surface />);

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
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText(
      '"bright-fox" was adopted, but Brainstrike couldn\'t confirm it\'s inside an open folder or its managed worktrees folder, so it can\'t be mounted automatically. Use the workspace bar\'s "Add Folder" to grant this worktree\'s folder directly, then try "New thread here" again.'
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('passes an UNRELATED addRootDirectoryByPath failure through verbatim, not the managed-worktree remedy', async () => {
    addRootDirectoryByPathMock.mockRejectedValueOnce(new Error('disk is full'));
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText('disk is full');
    expect(createThreadMock).not.toHaveBeenCalled();
  });

  it('states a loud error and never calls createThread when no agent host is attached', async () => {
    // (onNewThread's repository guard, added beside the existing !worktreeId
    // guard, must fail LOUD — a stated actionError, never a silent return —
    // and createThread must never be reached.)
    render(<WorktreeMapSurface />, { wrapper: WorktreesHost });

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
    render(<Surface />);

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
    setWorktreeMap({
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
    render(<Surface />);

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
    setWorktreeMap({
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
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /hand off to local/iu })).not.toBeInTheDocument();
  });

  it('does not show Hand off to Local anywhere when no thread is selected', async () => {
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /hand off to local/iu })).not.toBeInTheDocument();
  });

  it('archives through the worktrees bridge with the card worktree id and states a refusal verbatim', async () => {
    const refreshMock = vi.fn();
    archiveMock.mockResolvedValue(gitFailure('worktree has uncommitted changes'));
    setWorktreeMap({ ...BASE_STATE, refresh: refreshMock });
    render(<Surface />);

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
    setWorktreeMap({ ...BASE_STATE, refresh: refreshMock });
    render(<Surface />);

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
    render(<Surface />);

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
    setWorktreeMap({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, rootId: null } })],
        },
      ],
    });
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /add as root/iu }));

    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    // Same pin as onNewThread above: no caller-side refresh — the Map
    // re-loads via the root-identity subscription once the row exists.
    expect(refreshMock).not.toHaveBeenCalled();
    // Falsifier: adding a root never archives.
    expect(archiveMock).not.toHaveBeenCalled();
  });

  // An unmanaged card offers Adopt as its own ENABLED action (never a
  // disabled "coming soon" stub — A1/A7), and this is the FIRST real UI
  // caller of `worktrees.adopt`: Task 2 shipped the bridge method, but the
  // Mode chip picker's own planned call was unreachable and removed.
  it('adopts through the worktrees bridge with the card path, refreshes on success', async () => {
    const refreshMock = vi.fn();
    setWorktreeMap({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              disabledReason:
                'Created outside Brainstrike — adopting it is coming with the Worktree Map.',
              entry: { ...card().entry, id: null, managed: false, usable: false },
              provenanceLabel: 'External',
            }),
          ],
        },
      ],
    });
    render(<Surface />);

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
    adoptMock.mockResolvedValue(
      gitFailure(
        'The worktree at "/wt" is outside every open folder. Grant access to its folder first, then adopt it.'
      )
    );
    setWorktreeMap({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, id: null, managed: false, usable: false } })],
        },
      ],
    });
    render(<Surface />);

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
    setWorktreeMap({
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
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByRole('menuitem', { name: /^adopt$/iu })).not.toBeInTheDocument();
  });

  it('opens the pinned terminal for a card that is inside an open folder', async () => {
    render(<Surface />);

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
    setWorktreeMap({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, rootId: null } })],
        },
      ],
    });
    render(<Surface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    // Complementary, never both, never a disabled stub: the menu always names
    // the next step.
    expect(screen.getByRole('menuitem', { name: /add as root/iu })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /terminal/iu })).not.toBeInTheDocument();
  });

  it('omits Open in Terminal entirely when the platform has no terminal bridge', async () => {
    // No terminal provider in the tree, as on web.
    render(<WorktreeMapSurface />, { wrapper: WorktreesHost });

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
      render(<Surface />);
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
