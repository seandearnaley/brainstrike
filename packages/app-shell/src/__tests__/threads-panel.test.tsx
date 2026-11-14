// @vitest-environment jsdom

import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import {
  type AssistantMemoryThread,
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { act } from '@brainstrike/test-utils/react-act';
import type { WorktreeListEntry } from '@brainstrike/types';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, type ReactNode, useState } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  type AssistantHostProjects,
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
  createHostAssistantThreadRepository,
} from '../assistant-thread-host-context';
import {
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_ROW_PITCH_PX,
  THREAD_CONTROL_TITLE_CLASS_NAME,
} from '../assistant-thread-presentation';
import { SidebarHeaderContext } from '../sidebar-header';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';
import { getThreadPanelRowHeightPx } from '../thread-panel-visible-rows';
import { useThreadSearchStore } from '../thread-search-store';
import { ThreadsPanel } from '../threads-panel';
import { NO_WORKSPACE_GIT_SERVICES, WorkspaceGitServicesProvider } from '../workspace-git-services';
import { stubWorktreesBridge } from './helpers/workspace-git-services-wrapper';

const virtualizerState = vi.hoisted(() => ({
  estimatedSizes: [] as number[],
  windowSize: Number.POSITIVE_INFINITY,
}));

// TreeTable's real virtualizer depends on layout measurements that JSDOM does
// not provide. Render its complete disclosed row model here; a dedicated
// virtualization test covers the bounded mounted-window contract.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(
    ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => {
      // Geometry derives from the callback rather than a hardcoded pitch, so the
      // mock can't contradict the density contract the tests below assert.
      const sizes = Array.from({ length: count }, (_, index) => estimateSize(index));
      virtualizerState.estimatedSizes.push(...sizes);
      const offset = (index: number): number =>
        sizes.slice(0, index).reduce((total, size) => total + size, 0);
      return {
        getTotalSize: () => offset(count),
        getVirtualItems: () =>
          Array.from({ length: Math.min(count, virtualizerState.windowSize) }, (_, index) => ({
            end: offset(index) + (sizes[index] ?? 0),
            index,
            key: `thread-row-${index}`,
            size: sizes[index] ?? 0,
            start: offset(index),
          })),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
      };
    }
  ),
}));

const {
  fileExplorerMocks,
  fixture,
  gitMocks,
  groupRows,
  hostMocks,
  pinRows,
  placementRows,
  rootRows,
  runMocks,
  threadRows,
} = vi.hoisted(() => ({
  fileExplorerMocks: {
    // The Explorer's reopen of a recorded folder by its path, which shows a located folder.
    addRootDirectoryByPath: vi.fn<(path: string) => Promise<unknown>>(),
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  // Failure injection for the fake host.
  fixture: {
    deleteFailureThreadId: null as string | null,
    metadataFailureMessage: 'Metadata update failed.',
    metadataFailureThreadId: null as string | null,
  },
  // The host's worktree listing, which folder grouping reads once for the panel.
  gitMocks: {
    /** False renders the panel as a host with no worktrees bridge does. */
    available: true,
    list: vi.fn<() => Promise<BoundaryResult<readonly WorktreeListEntry[]>>>(),
  },
  groupRows: [] as Record<string, unknown>[],
  // The default fake host's operations; their implementations are installed per test.
  hostMocks: {
    createThread: vi.fn<AssistantThreadHostCapability['createThread']>(),
    deleteThread: vi.fn<AssistantThreadHostCapability['deleteThread']>(),
    listThreads: vi.fn<AssistantThreadHostCapability['listThreads']>(),
    ownsThread: vi.fn<AssistantThreadHostCapability['ownsThread']>(),
    renameThread: vi.fn<AssistantThreadHostCapability['renameThread']>(),
    updateThreadBinding: vi.fn<AssistantThreadHostCapability['updateThreadBinding']>(),
  },
  pinRows: [] as Record<string, unknown>[],
  placementRows: [] as Record<string, unknown>[],
  rootRows: [] as Record<string, unknown>[],
  // The host's committed runs, as its run-state snapshot reports them.
  runMocks: {
    listeners: new Set<() => void>(),
    runs: new Map<
      string,
      {
        completedAt: Date | null;
        needsInput: boolean;
        startedAt: Date | null;
        status: 'running';
      }
    >(),
  },
  threadRows: [] as Record<string, unknown>[],
}));

function parseMetadataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/** The runs the fixture threads last ran, as the host lists them on each thread. */
const LATEST_RUN_ROWS = [
  {
    completedAt: new Date('2026-04-22T11:00:10Z'),
    createdAt: new Date('2026-04-22T11:00:00Z'),
    error: null,
    id: 'run-1',
    model: 'gpt-5.2-chat-latest',
    modelSettings: { maxOutputTokens: 512 },
    provider: 'openai',
    providerOptions: { openai: { reasoningEffort: 'high' } },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    runtimeKind: 'hosted',
    startedAt: new Date('2026-04-22T11:00:00Z'),
    status: 'completed',
    threadId: 'thread-b',
    turnMessageId: null,
    updatedAt: new Date('2026-04-22T11:00:10Z'),
  },
  {
    completedAt: new Date('2026-04-22T09:00:10Z'),
    createdAt: new Date('2026-04-22T09:00:00Z'),
    error: null,
    id: 'run-openrouter-1',
    model: 'openai/gpt-5.6-terra',
    provider: 'openrouter',
    providerOptions: { openrouter: { reasoning: { effort: 'low', summary: 'auto' } } },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    runtimeKind: 'hosted',
    startedAt: new Date('2026-04-22T09:00:00Z'),
    status: 'completed',
    threadId: 'thread-a',
    turnMessageId: null,
    updatedAt: new Date('2026-04-22T09:00:10Z'),
  },
] as const;

/** A fixture row as the host lists it: parsed metadata and the thread's latest run. */
function toThread(row: Record<string, unknown>): AssistantMemoryThread {
  const metadata = parseMetadataObject(row['metadata']);
  const latestRun = LATEST_RUN_ROWS.find((run) => run.threadId === row['id']);
  return {
    createdAt: row['createdAt'] as Date,
    id: String(row['id']),
    ...(latestRun
      ? { latestRun: latestRun as unknown as NonNullable<AssistantMemoryThread['latestRun']> }
      : {}),
    ...(Object.keys(metadata).length > 0
      ? { metadata: metadata as NonNullable<AssistantMemoryThread['metadata']> }
      : {}),
    resourceId: String(row['resourceId']),
    title: String(row['title']),
    updatedAt: row['updatedAt'] as Date,
  };
}

/** A floor above every fixture run's completion time: all of them count as looked at. */
const FIXTURES_SEEN_AT = Date.parse('2026-04-23T00:00:00Z');

/** Lowers the floor, so the fixture runs finished while nobody was looking. */
function leaveFixtureRunsUnseen(): void {
  useAssistantThreadStore.setState({ unseenBaselineAt: 0 });
}

/** Replaces the host's run-state snapshot and notifies its subscribers. */
function setHostRuns(running: readonly string[], needsInput: readonly string[] = []): void {
  runMocks.runs = new Map(
    running.map((threadId) => [
      threadId,
      {
        completedAt: null,
        needsInput: needsInput.includes(threadId),
        startedAt: null,
        status: 'running' as const,
      },
    ])
  );
  for (const listener of runMocks.listeners) {
    listener();
  }
}

/** The groups capability Main exposes, over the fixture's group and placement rows. */
async function handleThreadGroupsRequest(input: {
  readonly operation: string;
  readonly [key: string]: unknown;
}): Promise<{
  groups: Record<string, unknown>[];
  pins: Record<string, unknown>[];
  placements: Record<string, unknown>[];
}> {
  const groupById = (groupId: unknown) => groupRows.find((row) => row['id'] === groupId);
  switch (input.operation) {
    case 'create':
      groupRows.push({ ...(input['group'] as Record<string, unknown>) });
      break;
    case 'delete': {
      const index = groupRows.findIndex((row) => row['id'] === input['groupId']);
      if (index >= 0) {
        groupRows.splice(index, 1);
      }
      for (const placement of placementRows) {
        if (placement['groupId'] === input['groupId']) {
          placement['groupId'] = null;
        }
      }
      break;
    }
    case 'rename': {
      const group = groupById(input['groupId']);
      if (group) {
        group['name'] = input['name'];
      }
      break;
    }
    case 'color': {
      const group = groupById(input['groupId']);
      if (group) {
        group['color'] = input['color'] ?? null;
      }
      break;
    }
    case 'icon': {
      const group = groupById(input['groupId']);
      if (group) {
        group['icon'] = input['icon'] ?? null;
      }
      break;
    }
    case 'ranks':
      for (const entry of input['entries'] as readonly { groupId: string; rank: string }[]) {
        const group = groupById(entry.groupId);
        if (group) {
          group['rank'] = entry.rank;
        }
      }
      break;
    case 'placements':
      for (const placement of input['placements'] as readonly Record<string, unknown>[]) {
        const index = placementRows.findIndex((row) => row['threadId'] === placement['threadId']);
        if (index >= 0) {
          placementRows[index] = { ...placement };
        } else {
          placementRows.push({ ...placement });
        }
      }
      break;
    case 'pin': {
      const pin = input['pin'] as Record<string, unknown>;
      pinRows.splice(
        0,
        pinRows.length,
        ...pinRows.filter((row) => row['threadId'] !== pin['threadId'])
      );
      pinRows.push({ ...pin });
      break;
    }
    case 'unpin':
      pinRows.splice(
        0,
        pinRows.length,
        ...pinRows.filter((row) => row['threadId'] !== input['threadId'])
      );
      break;
    case 'clear': {
      const threadIds = input['threadIds'] as readonly string[];
      for (let index = placementRows.length - 1; index >= 0; index -= 1) {
        if (threadIds.includes(String(placementRows[index]?.['threadId']))) {
          placementRows.splice(index, 1);
        }
      }
      break;
    }
    default:
      break;
  }
  return {
    groups: groupRows.map((row) => ({ ...row })),
    pins: pinRows.map((row) => ({ ...row })),
    placements: placementRows.map((row) => ({ ...row })),
  };
}

vi.mock('../thread-search-service', () => ({
  // Search returns no matches; the real controller still drives the host search.
  createThreadSearchService: () => ({
    searchThreads: () =>
      Promise.resolve({
        metadata: {
          ftsResultCount: 0,
          titleResultCount: 0,
          totalMs: 0,
        },
        results: [],
      }),
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  // The live-refresh subscription the worktree listing holds listens for it.
  FILE_EXPLORER_REFRESH_EVENT: 'brainstrike:file-explorer-refreshed',
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
  useFileSystem: () => ({
    addRootDirectoryByPath: fileExplorerMocks.addRootDirectoryByPath,
    rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle,
  }),
}));

/** The attached agent host: every operation runs over the fixture's in-memory rows. */
function createDefaultHost(): AssistantThreadHostCapability {
  return {
    createThread: hostMocks.createThread,
    deleteThread: hostMocks.deleteThread,
    listThreads: hostMocks.listThreads,
    ownsThread: hostMocks.ownsThread,
    renameThread: hostMocks.renameThread,
    renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
    renderThread: () => null,
    runs: {
      getSnapshot: () => runMocks.runs,
      subscribe: (listener) => {
        runMocks.listeners.add(listener);
        return () => {
          runMocks.listeners.delete(listener);
        };
      },
    },
    searchThreads: async () => ({ messages: [], titles: [] }),
    updateThreadBinding: hostMocks.updateThreadBinding,
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
}

/** Stands in for AgentWorkspaceLayout's left header row, where the toolbar renders. */
function SidebarHeader({ children }: { readonly children: ReactNode }): ReactElement {
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div data-testid="sidebar-header" ref={setHeader} />
      <SidebarHeaderContext.Provider value={header}>{children}</SidebarHeaderContext.Provider>
    </>
  );
}

function renderThreadsPanel(
  host: AssistantThreadHostCapability = createDefaultHost()
): ReturnType<typeof createTestActionRegistry> & { rerender(): void } {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  const gitServices = {
    ...NO_WORKSPACE_GIT_SERVICES,
    worktrees: gitMocks.available ? stubWorktreesBridge({ list: gitMocks.list }) : null,
  };
  const view = () => (
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <WorkspaceGitServicesProvider services={gitServices}>
        <AssistantThreadHostContext.Provider value={host}>
          <SidebarHeader>
            <ThreadsPanel />
          </SidebarHeader>
        </AssistantThreadHostContext.Provider>
      </WorkspaceGitServicesProvider>
      <Toaster />
    </ActionRegistryProvider>
  );
  const rendered = render(view());
  return { ...actionRegistry, rerender: () => rendered.rerender(view()) };
}

// Finish each real Radix popover's deferred autofocus before RTL removes its DOM.
afterEach(async () => {
  const triggers = screen
    .queryAllByRole('button', { expanded: true })
    .filter((trigger) => trigger.getAttribute('aria-haspopup') === 'dialog');
  for (const trigger of triggers) {
    // Toasts can own Escape; click this popover's trigger without moving focus
    // so the observed return focus belongs to Radix's deferred close callback.
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveFocus());
  }
});

beforeEach(() => {
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: {
      readRoots: async () => ({
        ok: true,
        value: rootRows.map((row) => ({ projectName: null, status: 'live', ...row })),
      }),
      request: async (input: Parameters<typeof handleThreadGroupsRequest>[0]) => ({
        ok: true,
        value: await handleThreadGroupsRequest(input),
      }),
    },
  });
  virtualizerState.windowSize = Number.POSITIVE_INFINITY;
  // Shared across every render in this file; without a reset it becomes
  // order-dependent state the next test to read it silently inherits.
  virtualizerState.estimatedSizes.length = 0;
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  fileExplorerMocks.addRootDirectoryByPath.mockReset().mockResolvedValue(null);
  fixture.deleteFailureThreadId = null;
  fixture.metadataFailureMessage = 'Metadata update failed.';
  fixture.metadataFailureThreadId = null;
  gitMocks.available = true;
  // No open folder is a repository unless a test lists one.
  gitMocks.list.mockReset().mockResolvedValue({ ok: true, value: [] });
  rootRows.splice(0, rootRows.length);
  runMocks.listeners.clear();
  runMocks.runs = new Map();
  resetToastStore();
  groupRows.splice(0, groupRows.length);
  placementRows.splice(0, placementRows.length);
  pinRows.splice(0, pinRows.length);
  useAssistantThreadGroupsStore.getState().reset();
  // Most cases here exercise custom groups and the flat list; the date default
  // has its own describe below.
  useAssistantThreadGroupsStore.setState({ groupBy: 'custom-groups' });
  // Session-scoped and previously never reset here: a test that types into the
  // search box left every later test rendering search results.
  useThreadSearchStore.getState().clearSearch();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    // Persisted and module-scope: without this reset, a test that opens a
    // thread leaves every later test's "unseen" watermark already stamped.
    lastViewedAtByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
    // As the real store stamps it at creation: AFTER these fixtures' 2026-04
    // completion times, so nothing waits to be looked at by default and the
    // Needs you strip is absent. A test about unseen runs lowers the floor.
    unseenBaselineAt: FIXTURES_SEEN_AT,
  });
  threadRows.splice(
    0,
    threadRows.length,
    {
      createdAt: new Date('2026-04-22T10:00:00Z'),
      id: 'thread-b',
      metadata: JSON.stringify({ color: 'blue', icon: 'message' }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Second thread',
      updatedAt: new Date('2026-04-22T11:00:00Z'),
    },
    {
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-a',
      metadata: JSON.stringify({ color: 'emerald', icon: 'code' }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'First thread',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    }
  );
  hostMocks.listThreads.mockReset().mockImplementation(async () => threadRows.map(toThread));
  hostMocks.createThread.mockReset().mockImplementation(async (resourceId) => {
    const row = {
      createdAt: new Date(),
      id: `thread-${crypto.randomUUID()}`,
      metadata: null,
      resourceId,
      title: 'New Thread',
      updatedAt: new Date(),
    };
    threadRows.unshift(row);
    return toThread(row);
  });
  hostMocks.deleteThread.mockReset().mockImplementation(async (threadId) => {
    if (fixture.deleteFailureThreadId === threadId) {
      throw new Error('Delete failed.');
    }
    const index = threadRows.findIndex((row) => row['id'] === threadId);
    if (index < 0) {
      return;
    }
    threadRows.splice(index, 1);
    return [threadId];
  });
  hostMocks.ownsThread
    .mockReset()
    .mockImplementation(async (threadId) => threadRows.some((row) => row['id'] === threadId));
  hostMocks.renameThread.mockReset().mockImplementation(async (threadId, title) => {
    // The host never commits a blank title.
    if (!title.trim()) {
      throw new Error('Thread title is required.');
    }
    const row = threadRows.find((item) => item['id'] === threadId);
    if (row) {
      row['title'] = title;
    }
  });
  hostMocks.updateThreadBinding.mockReset().mockImplementation(async (threadId, metadata) => {
    if (fixture.metadataFailureThreadId === threadId || fixture.metadataFailureThreadId === '*') {
      throw new Error(fixture.metadataFailureMessage);
    }
    const row = threadRows.find((item) => item['id'] === threadId);
    if (row) {
      row['metadata'] = JSON.stringify({ ...parseMetadataObject(row['metadata']), ...metadata });
    }
  });
});

describe('ThreadsPanel', () => {
  it('shows independent reduced-motion-safe activity spinners without replacing thread icons', async () => {
    setHostRuns(['thread-a', 'thread-b']);
    const view = renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-active-spinner')).toHaveLength(2);
    });

    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    const secondThreadRow = screen
      .getByText('Second thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    expect(firstThreadRow).not.toBeNull();
    expect(secondThreadRow).not.toBeNull();
    if (!(firstThreadRow && secondThreadRow)) {
      throw new Error('Expected both thread rows to render.');
    }

    expect(within(firstThreadRow).getByTestId('thread-icon-code')).toBeVisible();
    expect(within(secondThreadRow).getByTestId('thread-icon-message')).toBeVisible();
    expect(within(firstThreadRow).getByRole('img', { name: 'First thread is active' })).toHaveClass(
      'motion-reduce:animate-none'
    );
    expect(
      within(secondThreadRow).getByRole('img', { name: 'Second thread is active' })
    ).toBeVisible();

    act(() => setHostRuns([]));
    view.rerender();
    act(() => {
      useAssistantThreadStore.setState((state) => ({
        selectedThreadByResourceId: { ...state.selectedThreadByResourceId },
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('thread-active-spinner')).not.toBeInTheDocument();
    });
    expect(within(firstThreadRow).getByTestId('thread-icon-code')).toBeVisible();
    expect(within(secondThreadRow).getByTestId('thread-icon-message')).toBeVisible();
  });

  it('keeps the durable activity subscription live while thread creation reloads the list', async () => {
    setHostRuns(['thread-a']);
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-active-spinner')).toBeVisible();
    act(() => {
      useAssistantThreadStore.setState((state) => ({
        loadStateByResourceId: {
          ...state.loadStateByResourceId,
          [WORKSPACE_MEMORY_RESOURCE_ID]: { status: 'loading' },
        },
      }));
    });

    expect(screen.getByTestId('thread-active-spinner')).toBeVisible();
  });

  it('puts its toolbar in the sidebar header, leaving only the search row above the list', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const toolbar = screen.getByTestId('threads-panel-toolbar');
    const search = screen.getByTestId('threads-panel-search');
    // The toolbar owns the heading, the live count, and the select-visible
    // control, and it renders in the layout's header row, so the search row is
    // the panel's only chrome above the list.
    expect(toolbar.parentElement).toBe(screen.getByTestId('sidebar-header'));
    expect(within(toolbar).getByRole('heading', { name: 'Threads' })).toBeVisible();
    expect(within(toolbar).getByTestId('threads-visible-count')).toHaveTextContent('2');
    expect(within(toolbar).getByRole('button', { name: 'Select threads' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'New thread' })).toBeVisible();
    expect(within(search).getByTestId('thread-search-input')).toBeVisible();
    expect(screen.getByTestId('threads-panel').firstElementChild).toBe(search);
    expect(screen.queryByTestId('threads-panel-select-band')).not.toBeInTheDocument();

    // One row of controls only reads as a row when the controls are the same
    // size; the view-options trigger used to be 32px next to 28px neighbours.
    // Same 28px square for every control, New Thread included — it only grows
    // into a labelled pill at @[360px]/threads-toolbar, where the label appears.
    for (const label of ['Select threads', 'View options', 'New group', 'New thread']) {
      expect(within(toolbar).getByRole('button', { name: label })).toHaveClass('size-7');
    }
    // Every control hovers toward the same accent. New Thread keeps a resting
    // fill because it is the primary action, but `secondary/80` alone hovered
    // LIGHTER while its ghost neighbours hovered darker — opposite directions
    // in one row.
    for (const label of ['Select threads', 'View options', 'New group', 'New thread']) {
      expect(within(toolbar).getByRole('button', { name: label })).toHaveClass(
        'hover:bg-accent',
        'hover:text-accent-foreground'
      );
    }
    // Declared icon metrics must be the rendered ones: `h-3.5 w-3.5` loses to
    // the button base rule's `size-4`, so the icons render 16px, not 14px.
    for (const icon of toolbar.querySelectorAll('svg')) {
      expect(icon).toHaveClass('size-3.5');
    }
  });

  it('hides the row checkboxes until Select threads is pressed, and Done drops the selection', async () => {
    renderThreadsPanel();

    const toggle = await screen.findByRole('button', { name: 'Select threads' });
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('checkbox', { name: 'Select thread First thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Select|Clear) \d+ visible/u })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select thread First thread' }));
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '1 selected'
    );

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('checkbox', { name: 'Select thread First thread' })).toBeNull();
    expect(
      screen.queryByRole('toolbar', { name: 'Thread selection actions' })
    ).not.toBeInTheDocument();
  });

  it('stays in selection mode after a keyboard selection is unchecked', async () => {
    threadRows.splice(1);
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    fireEvent.keyDown(screen.getByRole('treegrid', { name: 'Workspace threads' }), {
      ctrlKey: true,
      key: 'a',
    });
    expect(screen.getByRole('button', { name: 'Select threads' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    const checkbox = screen.getByRole('checkbox', { name: /^Select thread /u });
    expect(checkbox).toBeChecked();
    checkbox.focus();
    fireEvent.click(checkbox);
    expect(
      screen.queryByRole('toolbar', { name: 'Thread selection actions' })
    ).not.toBeInTheDocument();
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveFocus();
  });

  it('reads the visible count as singular when one thread is disclosed', async () => {
    threadRows.splice(1);

    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));
    expect(screen.getByRole('button', { name: 'Select 1 visible thread' })).toBeVisible();
    expect(screen.getByTestId('threads-visible-count')).toHaveTextContent('1 thread visible');
  });

  it('withdraws the count and select-visible toggle while search replaces the list', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(screen.getByTestId('threads-visible-count')).toBeVisible();

    // Search results replace the treegrid, and the bulk-selection overlay lives
    // inside that now-hidden subtree. A live toggle here would select threads
    // the user cannot see, with no action bar and no way to clear.
    fireEvent.change(screen.getByTestId('thread-search-input'), { target: { value: 'alpha' } });

    await waitFor(() => {
      expect(screen.queryByTestId('threads-visible-count')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /visible threads?$/u })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(hostMocks.listThreads).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID);
    });
    expect(useThreadSearchStore.getState().status).toBe('results');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeVisible();
  });

  it('withdraws the count and select-visible toggle while a state card replaces the list', () => {
    // The first catalog read is pending, so the loading card stands in for the list.
    const firstRead = Promise.withResolvers<AssistantMemoryThread[]>();
    hostMocks.listThreads.mockReturnValue(firstRead.promise);
    // The store memoizes the in-flight load across tests; settle it.
    onTestFinished(() => firstRead.resolve([]));

    renderThreadsPanel();

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.queryByTestId('threads-visible-count')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /visible threads?$/u })).not.toBeInTheDocument();
  });

  it('drops the redundant Memory pill and its restated subtitle from the toolbar', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    expect(screen.queryByTestId('threads-preview-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace-scoped Mastra history')).not.toBeInTheDocument();
  });

  it('renders the disclosed collection through the shared virtual treegrid scroll owner', async () => {
    renderThreadsPanel();

    const treegrid = await screen.findByRole('treegrid', { name: 'Workspace threads' });
    expect(treegrid).toHaveAttribute('aria-multiselectable', 'true');
    expect(treegrid).toHaveClass('outline-none');
    expect(treegrid.querySelector('thead')).toBeNull();

    const viewport = treegrid.parentElement;
    expect(viewport).toHaveClass('overflow-auto');
    expect(viewport).toHaveStyle({ maxHeight: 'none' });
    expect(screen.getAllByTestId('thread-row')[0]?.closest('tr')).toHaveClass(
      'group/thread-tree-row'
    );
    expect(screen.getAllByTestId('thread-row')[0]).not.toHaveClass('border');
    expect(screen.getAllByTestId('thread-row')[0]).not.toHaveClass(
      'group-data-[focused=true]/thread-tree-row:outline-2'
    );
    expect(viewport?.parentElement?.parentElement).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('threads-panel')).toHaveClass('@container/threads', 'h-full');

    // A coloured row carries a soft wash of its colour over the explorer's
    // plain row: no fill of its own, no border, no ring.
    const idleThread = screen.getByText('First thread').closest('[data-testid="thread-row"]');
    expect(idleThread).toHaveClass('bs-thread-wash', 'hover:bg-accent/60');
    expect(idleThread).not.toHaveClass('bg-emerald-100/45', 'ring-1', 'border');
  });

  it('keeps row action chips inside the row instead of filling its full height', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const expand = screen.getByRole('button', { name: /Show thread details First thread/u });
    const actions = screen.getByRole('button', { name: /Thread actions First thread/u });

    for (const control of [expand, actions]) {
      // icon-xs paints a 28px chip, which is now the entire row height, so the
      // hover fill runs edge to edge. 20px leaves 4px above and below and
      // matches the tab's close affordance.
      expect(control).toHaveClass(...THREAD_CONTROL_ACTION_CLASS_NAME.split(' '));
      expect(control).not.toHaveClass('size-7');
      // Hover rides the tinted row rather than punching a neutral chip into it.
      expect(control).not.toHaveClass('hover:bg-accent');
      // Visual box shrinks but the pointer target stays >= 24px.
      expect(control.className).toMatch(/after:-inset-1/u);
      expect(control.querySelector('svg')).toHaveClass('size-3.5');
    }
  });

  it('pads the expanded details block evenly against the row edges', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: /Show thread details First thread/u }));

    // The row supplies px-1 horizontally and no vertical padding (vertical
    // padding would push the collapsed control past the tab's 28px). So the
    // block itself carries a matching 4px below, or it sits flush against the
    // row's bottom edge while both sides are inset.
    const details = await screen.findByTestId('thread-expanded-details');
    expect(details).toHaveClass('mb-1');
    expect(details.closest('[data-testid="thread-row"]')).toHaveClass('px-1');
  });

  it('sizes rows from the shared thread control density contract', async () => {
    virtualizerState.estimatedSizes.length = 0;
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const title = screen.getByText('First thread');
    const row = title.closest<HTMLElement>('[data-testid="thread-row"]');
    if (!row) {
      throw new Error('expected the thread title to be inside a thread row');
    }

    // A row and a tab render the same object, so they share one height.
    expect(row).toHaveClass(THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME);
    expect(row).not.toHaveClass('min-h-9');
    // The 28px control plus its 2px margins is the virtual row pitch — vertical
    // padding would push the painted control past the tab's height.
    expect(row).toHaveClass('my-0.5');
    expect(row).not.toHaveClass('py-0.5');
    // A flat view is all thread rows, so every estimate is the shared pitch.
    expect(new Set(virtualizerState.estimatedSizes)).toEqual(
      new Set([getThreadPanelRowHeightPx('thread')])
    );
    expect(virtualizerState.estimatedSizes).toContain(THREAD_CONTROL_ROW_PITCH_PX);

    expect(title).toHaveClass(...THREAD_CONTROL_TITLE_CLASS_NAME.split(' '));
    expect(title).not.toHaveClass('text-[13px]');

    const mark = within(row).getByTestId('thread-color-emerald');
    expect(mark).toHaveClass(...THREAD_CONTROL_MARK_CLASS_NAME.split(' '));
    expect(mark).not.toHaveClass('size-6');
    // A soft tint of the thread colour, not a solid swatch.
    expect(mark).toHaveClass('bs-thread-mark');
    expect(mark).not.toHaveClass('bg-emerald-500');
  });

  it('mounts only the virtual window for a large disclosed collection', async () => {
    virtualizerState.windowSize = 12;
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 100; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-window-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Window thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    const treegrid = await screen.findByRole('treegrid', { name: 'Workspace threads' });
    expect(treegrid).toHaveAttribute('aria-rowcount', '51');
    expect(screen.getAllByTestId('thread-row')).toHaveLength(12);
  });

  it('discloses 50 more threads with the exact remaining count', async () => {
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 50; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-extra-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Extra thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    expect(await screen.findByRole('button', { name: 'Show 2 more threads' })).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more threads' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(52);
    });
    expect(screen.queryByRole('button', { name: /Show .* more threads/u })).not.toBeInTheDocument();
  });

  it('selects only disclosed threads and scopes Escape clearing to the thread panel', async () => {
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 50; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-extra-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Extra thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select 50 visible threads' }));
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '50 selected'
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '50 selected'
    );

    const clearVisible = screen.getByRole('button', { name: 'Clear 50 visible threads' });
    clearVisible.focus();
    fireEvent.keyDown(clearVisible, { key: 'Escape' });
    expect(
      screen.queryByRole('toolbar', { name: 'Thread selection actions' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select threads' })).toHaveFocus();
  });

  it('offers staged bulk color and delete actions while retaining selection on failure', async () => {
    placementRows.push({
      flatRank: 'flat-b',
      groupId: 'group-research',
      rank: 'a0',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      threadId: 'thread-b',
    });
    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select 2 visible threads' }));
    const toolbar = screen.getByRole('toolbar', { name: 'Thread selection actions' });
    const overlay = screen.getByTestId('selection-action-overlay');
    expect(overlay).toHaveClass('bottom-3');
    expect(overlay).not.toHaveClass('top-12');
    expect(toolbar.parentElement).toBe(overlay);
    expect(toolbar).toHaveClass('w-full');
    expect(screen.getByRole('treegrid', { name: 'Workspace threads' }).parentElement).toHaveClass(
      'pb-20'
    );
    expect(within(toolbar).getByRole('button', { name: 'Move' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'Color' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'Delete' })).toBeVisible();

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Color' }));
    const bulkColorGrid = await screen.findByTestId('thread-bulk-color-grid');
    expect(within(bulkColorGrid).getByText('Voltage')).toBeVisible();
    expect(within(bulkColorGrid).getByText('Afterglow')).toBeVisible();
    for (const button of within(bulkColorGrid).getAllByRole('button')) {
      expect(button).toHaveClass('size-8');
    }
    // The host catalog has no atomic bulk metadata update, so applying a color
    // is not exercised here; the color grid itself is.
    fireEvent.keyDown(bulkColorGrid, { key: 'Escape' });
    fixture.deleteFailureThreadId = 'thread-b';
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete 2 selected threads?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText('Delete failed.')).toBeVisible();
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '2 selected'
    );
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(placementRows).toEqual([
      expect.objectContaining({ flatRank: 'flat-b', threadId: 'thread-b' }),
    ]);
  });
  it('loads workspace-global threads even when no folder is open', async () => {
    // Multi-root: assistant memory is workspace-global and usable with zero roots.
    // There is no "open a folder first" gate, and threads are keyed on a stable
    // resource id rather than the focused root path.
    fileExplorerMocks.rootDirectoryHandle = null;

    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(screen.queryByText('No workspace open')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New thread' })).toBeEnabled();
  });

  it('lists workspace-scoped threads from the host', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(hostMocks.listThreads).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(screen.getByText('First thread')).toBeVisible();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.getByText('OpenAI')).toBeVisible();
    expect(screen.getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(screen.getByText('openai/gpt-5.6-terra')).toBeVisible();
    expect(screen.getByText('Reasoning: high')).toBeVisible();
    expect(screen.getByText('Reasoning: low')).toBeVisible();
    expect(screen.getByText('Max output: 512')).toBeVisible();
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');
  });

  it('renders curated thread identity without using the uuid as the primary row label', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThread = screen.getAllByTestId('thread-row')[0];
    if (!secondThread) {
      throw new Error('Expected second thread row to render.');
    }

    expect(within(secondThread).getByTestId('thread-icon-message')).toBeVisible();
    expect(within(secondThread).getByTestId('thread-color-blue')).toBeVisible();
    expect(within(secondThread).getByText('Second thread')).toBeVisible();
    expect(within(secondThread).getByText('OpenAI')).toBeVisible();
    expect(within(secondThread).getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(within(secondThread).queryByText('thread-b')).not.toBeInTheDocument();
  });

  it('uses the right-clicked row for copy and Open without selecting on menu open', async () => {
    const { writtenTexts } = renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const firstThreadTitle = screen.getByText('First thread');

    fireEvent.contextMenu(firstThreadTitle);
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread Title' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['First thread']);
    });

    fireEvent.contextMenu(firstThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread ID' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['First thread', 'thread-a']);
    });

    fireEvent.contextMenu(firstThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
  });

  it('enters the existing rename flow and preserves the input native context menu', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select threads' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select 2 visible threads' }));
    fireEvent.contextMenu(screen.getByText('Second thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const titleInput = screen.getByRole('textbox', { name: 'Thread title' });
    expect(titleInput).toHaveValue('Second thread');
    expect(hostMocks.renameThread).not.toHaveBeenCalled();

    fireEvent.contextMenu(titleInput);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const selectionSummaryBeforeEscape = screen.getByRole('toolbar', {
      name: 'Thread selection actions',
    }).textContent;
    fireEvent.change(titleInput, { target: { value: 'Discard this draft' } });
    fireEvent.keyDown(titleInput, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Thread title' })).not.toBeInTheDocument();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' }).textContent).toBe(
      selectionSummaryBeforeEscape
    );
  });

  it('reuses customization, details, and delete-confirmation row flows', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThreadTitle = screen.getByText('Second thread');

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Customize…' }));
    expect(screen.getByRole('button', { name: 'Use Bug icon' })).toBeVisible();
    expect(hostMocks.updateThreadBinding).not.toHaveBeenCalled();

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show Details' }));
    expect(screen.getByTestId('thread-expanded-details')).toBeVisible();

    fireEvent.contextMenu(secondThreadTitle);
    expect(await screen.findByRole('menuitem', { name: 'Hide Details' })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Second thread' })
    ).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(hostMocks.deleteThread).not.toHaveBeenCalled();
  });

  it('customizes thread identity in the stable row-actions popover', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(
      screen.queryByRole('button', { name: 'Customize thread Second thread' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    await user.click(within(customizer).getByRole('button', { name: 'Use Bug icon' }));
    await user.click(within(customizer).getByRole('button', { name: 'Use Rose color' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-icon-bug')).toBeVisible();
    });
    expect(screen.getByTestId('thread-color-rose')).toBeVisible();
    expect(hostMocks.updateThreadBinding).toHaveBeenCalledWith(
      'thread-b',
      expect.objectContaining({ icon: 'bug' })
    );
    expect(hostMocks.updateThreadBinding).toHaveBeenCalledWith(
      'thread-b',
      expect.objectContaining({ color: 'rose' })
    );
    const persistedRow = threadRows.find((row) => row['id'] === 'thread-b');
    expect(JSON.parse(String(persistedRow?.['metadata']))).toMatchObject({
      color: 'rose',
      icon: 'bug',
    });
    expect(persistedRow?.['updatedAt']).toEqual(new Date('2026-04-22T11:00:00Z'));
  });

  it('keeps thread detail and action controls out of row selection', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Select thread Second thread',
    });
    expect(checkbox.parentElement).toHaveAttribute('data-tree-controls-position', 'top');

    await user.click(screen.getByRole('button', { name: 'Show thread details Second thread' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Customize' }));
    await user.click(screen.getByRole('button', { name: 'Use Bug icon' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('opens a thread without implicitly adding it to bulk selection', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));

    const firstThreadCheckbox = await screen.findByRole('checkbox', {
      name: 'Select thread First thread',
    });
    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!firstThreadRow) {
      throw new Error('Expected the first thread row to render.');
    }

    await user.click(within(firstThreadRow).getByRole('button', { name: /^First thread/u }));
    fireEvent.click(firstThreadRow);

    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(firstThreadCheckbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('keeps keyboard activation of a thread title out of explicit checkbox selection', async () => {
    renderThreadsPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));

    const firstThreadCheckbox = await screen.findByRole('checkbox', {
      name: 'Select thread First thread',
    });
    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!firstThreadRow) {
      throw new Error('Expected the first thread row to render.');
    }

    fireEvent.click(firstThreadRow);
    fireEvent.keyDown(within(firstThreadRow).getByRole('button', { name: /^First thread/u }), {
      key: ' ',
    });

    expect(firstThreadCheckbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('selects with the explorer fill and keeps colour to a wash, with breathing room around each thread', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const [activeThread, idleThread] = screen.getAllByTestId('thread-row');

    // The selected row takes the explorer's accent fill under its colour wash:
    // no outline, no ring, no border. Idle rows keep only the wash.
    expect(activeThread).toHaveAttribute('data-selected', 'true');
    expect(activeThread).toHaveClass(
      'my-0.5',
      THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
      'data-[selected=true]:bg-accent',
      'bs-thread-wash'
    );
    expect(activeThread).not.toHaveClass('ring-1', 'shadow-xs', 'border');
    expect(idleThread).toHaveAttribute('data-selected', 'false');
    expect(idleThread).toHaveClass(
      'my-0.5',
      THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
      'bs-thread-wash'
    );
    expect(idleThread).not.toHaveClass('shadow-xs', 'border');

    // The content stack is shorter than the row's min-height; the row must
    // center it vertically so the icon/title never pin to the top edge.
    for (const thread of [activeThread, idleThread]) {
      expect(thread).toHaveClass('flex', 'flex-col', 'justify-center');
    }
  });

  it('shows automatic expanded metadata and keeps diagnostics out of the primary row', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThread = screen.getAllByTestId('thread-row')[0];
    if (!secondThread) {
      throw new Error('Expected second thread row to render.');
    }
    expect(within(secondThread).queryByText('thread-b')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show thread details Second thread' }));

    const details = within(secondThread).getByTestId('thread-expanded-details');
    expect(within(details).getByText('Provider')).toBeVisible();
    expect(within(details).getByText('OpenAI')).toBeVisible();
    expect(within(details).getByText('Model')).toBeVisible();
    expect(within(details).getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(within(details).getByText('Runtime')).toBeVisible();
    expect(within(details).getByText('hosted')).toBeVisible();
    expect(within(details).getByText('Status')).toBeVisible();
    expect(within(details).getByText('completed')).toBeVisible();
    expect(within(details).getByText('Reasoning')).toBeVisible();
    expect(within(details).getByText('high')).toBeVisible();
    expect(within(details).getByText('Max output')).toBeVisible();
    expect(within(details).getByText('512')).toBeVisible();
    expect(within(details).getByText('Diagnostics')).toBeVisible();
    expect(within(details).getByText('thread-b')).toBeVisible();
    expect(within(details).queryByText('Notes')).not.toBeInTheDocument();
    expect(within(details).queryByText('Description')).not.toBeInTheDocument();
  });

  it('opens the new-thread screen without creating a thread', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'New thread' }));

    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBeUndefined();
    expect(hostMocks.createThread).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
  });

  it('renames a thread through the host', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    await user.clear(input);
    await user.type(input, 'Deployment plan');
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));

    await waitFor(() => {
      expect(screen.getByText('Deployment plan')).toBeVisible();
    });
    expect(hostMocks.renameThread).toHaveBeenCalledWith('thread-b', 'Deployment plan');
  });

  it('keeps rename validation local to the row', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));

    expect(await screen.findByText('Thread title is required.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Thread title' })).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
  });

  it('deletes a thread only after explicit confirmation', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Second thread' })
    ).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    expect(hostMocks.deleteThread).toHaveBeenCalledWith('thread-b');
    expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a']);
  });

  it('keeps delete errors local to the row without collapsing the thread list', async () => {
    const user = userEvent.setup();
    fixture.deleteFailureThreadId = 'thread-b';
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    expect(await screen.findByText('Delete failed.')).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
  });
});

describe('ThreadsPanel groups', () => {
  function seedGroup(id: string, name: string, rank: string): void {
    groupRows.push({
      color: null,
      icon: null,
      id,
      name,
      rank,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    });
  }

  function seedPlacement(threadId: string, groupId: string | null, rank: string): void {
    placementRows.push({
      flatRank: null,
      groupId,
      rank,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      threadId,
    });
  }

  it('sizes group headers at the thread pitch so the levels read as one tree', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();
    await screen.findByTestId('thread-group-section');

    expect(virtualizerState.estimatedSizes).toContain(getThreadPanelRowHeightPx('group'));
    expect(getThreadPanelRowHeightPx('group')).toBe(getThreadPanelRowHeightPx('thread'));
  });

  it('renders group sections with the ungrouped section below', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    expect(within(section).getByText('Research')).toBeVisible();
    expect(within(section).getByText('Research')).toHaveClass('text-xs', 'leading-4');
    // Group headers share the thread rows' 8px chip-to-text rhythm so group
    // names start at exactly the same x as thread titles.
    expect(within(section).getByText('Research').parentElement).toHaveClass('gap-2');
    expect(within(section).getByText('Research').parentElement).not.toHaveClass('gap-1');
    const nestedThreadRow = screen.getByText('Second thread').closest('tr');
    expect(nestedThreadRow).toHaveAttribute('data-depth', '1');
    expect(nestedThreadRow?.querySelector<HTMLElement>('td > div > span')).toHaveStyle({
      width: '16px',
    });
    const ungrouped = screen.getByTestId('threads-ungrouped-section');
    expect(ungrouped.closest('tr')).not.toHaveClass('[&_[role=gridcell]>div]:pl-7');
    expect(within(ungrouped).getByTestId('threads-ungrouped-icon')).toHaveClass('size-5');
    expect(within(ungrouped).getByText('Ungrouped')).toBeVisible();
    expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    const sectionOrder = Array.from(
      document.querySelectorAll(
        '[data-testid="thread-group-section"], [data-testid="threads-ungrouped-section"]'
      )
    ).map((element) => element.getAttribute('data-testid'));
    expect(sectionOrder).toEqual(['thread-group-section', 'threads-ungrouped-section']);
  });

  it('exposes Ungrouped as an expandable parent with symmetric tree navigation', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const ungroupedRow = (await screen.findByTestId('threads-ungrouped-section')).closest('tr');
    const ungroupedThreadRow = screen.getByText('First thread').closest('tr');
    const treegrid = screen.getByRole('treegrid', { name: 'Workspace threads' });
    expect(ungroupedRow).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(ungroupedRow as HTMLElement);
    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    expect(ungroupedThreadRow).toHaveAttribute('data-focused', 'true');

    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    expect(ungroupedRow).toHaveAttribute('data-focused', 'true');
    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(ungroupedRow).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('First thread')).not.toBeInTheDocument();
    });
    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(ungroupedRow).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('First thread')).toBeVisible();
    });
  });

  it('uses a tri-state group checkbox to select undisclosed members', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');
    for (let index = 0; index < 51; index += 1) {
      const threadId = `thread-grouped-${index}`;
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: threadId,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Grouped thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
      seedPlacement(threadId, 'group-research', `b${String(index).padStart(2, '0')}`);
    }

    renderThreadsPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));

    const groupCheckbox = await screen.findByRole('checkbox', {
      name: 'Select all 52 threads in Research',
    });
    expect(groupCheckbox.parentElement).toHaveAttribute('data-tree-controls-position', 'top');
    expect(groupCheckbox).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(groupCheckbox);

    expect(groupCheckbox).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '52 selected'
    );
  });

  it('assigns group icon and color through the durable store and wraps the entire grouped surface', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-a', 'group-research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a1');

    renderThreadsPanel();

    expect(
      screen.queryByRole('button', { name: 'Customize group Research' })
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    const groupCustomizer = screen.getByRole('dialog');
    const groupIconGrid = within(groupCustomizer).getByTestId('thread-group-icon-grid');
    expect(groupIconGrid).toHaveClass('grid-cols-6');
    fireEvent.click(
      within(groupCustomizer).getByRole('button', { name: 'Use Research icon for Research' })
    );
    await waitFor(() => {
      expect(screen.getByTestId('thread-group-icon-research')).toBeVisible();
    });
    expect(groupRows[0]).toMatchObject({ icon: 'research', id: 'group-research' });
    const folderColorGrid = within(groupCustomizer).getByTestId('thread-group-color-grid');
    expect(within(folderColorGrid).getByText('Voltage')).toBeVisible();
    expect(within(folderColorGrid).getByText('Afterglow')).toBeVisible();
    expect(within(folderColorGrid).getAllByRole('button')).toHaveLength(19);
    fireEvent.click(await screen.findByRole('button', { name: 'Use Rose color for Research' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-group-color-rose')).toBeVisible();
    });
    // A colour tints the chip only: no gray slab, outline or chassis wraps
    // the grouped rows.
    expect(screen.getByTestId('thread-group-color-rose')).toHaveClass('bs-thread-mark');
    expect(document.querySelector('tr.thread-group-surface')).toBeNull();
    expect(groupRows[0]).toMatchObject({ color: 'rose', id: 'group-research' });

    fireEvent.click(
      within(screen.getByText('Research').closest('tr') as HTMLElement).getByRole('button', {
        name: 'Collapse',
      })
    );
    await waitFor(() => {
      expect(screen.queryByText('First thread')).not.toBeInTheDocument();
      expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Clear color for Research' }));
    await waitFor(() => {
      expect(screen.getByTestId('thread-group-color-unassigned')).toBeVisible();
    });
  });

  it('moves selected grouped threads to Ungrouped without discarding flat rank', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-a', 'group-research', 'a0');
    placementRows[0] = { ...placementRows[0], flatRank: 'flat-a' };

    renderThreadsPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Select threads' }));

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select thread First thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ungrouped' }));

    await waitFor(() => {
      expect(useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-a']).toEqual(
        expect.objectContaining({ flatRank: 'flat-a', groupId: null })
      );
    });
  });

  it('makes the expanded group body a drop target so the empty hint works', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    const hint = screen.getByText('Drop threads here');
    const bodyDropTarget = hint.closest('[data-drop-target-for-element="true"]');
    expect(bodyDropTarget).not.toBeNull();
    // The body target must be distinct from the header target so a drop on the
    // hint area files the thread even without touching the header.
    const header = within(section).getByTestId('thread-group-header');
    expect(bodyDropTarget?.contains(header)).toBe(false);
    const headerLane = header.closest<HTMLElement>('[data-testid="thread-panel-content-lane"]');
    const hintLane = hint.closest<HTMLElement>('[data-testid="thread-panel-content-lane"]');
    expect(headerLane).toHaveClass('mx-1');
    expect(hintLane).toHaveClass('mx-1');
    expect(hint.closest('[data-testid="thread-panel-drop-zone"]')).not.toBeNull();
  });

  it('collapses and expands a group', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    const groupRow = section.closest('tr');
    const treegrid = screen.getByRole('treegrid', { name: 'Workspace threads' });
    expect(groupRow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Second thread')).toBeVisible();

    fireEvent.click(groupRow as HTMLElement);
    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(groupRow).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    });

    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(groupRow).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Second thread')).toBeVisible();
    });
  });

  it('creates a group from the header button and names it inline', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));

    const nameInput = await screen.findByRole('textbox', { name: 'Group name' });
    expect(nameInput).toHaveValue('New group');
    const newGroupHeader = nameInput.closest<HTMLElement>('[data-testid="thread-group-header"]');
    const newGroupLane = nameInput.closest<HTMLElement>(
      '[data-testid="thread-panel-content-lane"]'
    );
    expect(newGroupHeader).toHaveClass('min-w-0');
    expect(newGroupLane).toHaveClass('mx-1');
    expect(nameInput).toHaveClass('text-[13px]', 'leading-4');
    fireEvent.change(nameInput, { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group name' }));

    await waitFor(() => {
      expect(screen.getByText('Planning')).toBeVisible();
    });
    expect(groupRows).toEqual([expect.objectContaining({ name: 'Planning' })]);
  });

  it('renames a group inline', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const nameInput = screen.getByRole('textbox', { name: 'Group name' });
    fireEvent.change(nameInput, { target: { value: 'Deep Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group name' }));

    await waitFor(() => {
      expect(screen.getByText('Deep Work')).toBeVisible();
    });
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(groupRows).toEqual([
      expect.objectContaining({ id: 'group-research', name: 'Deep Work' }),
    ]);
  });

  it('deletes a group and returns its threads to the flat list', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));

    expect(screen.getByText('Delete folder Research?')).toBeVisible();
    expect(screen.getByTestId('thread-group-section')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete group Research' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-group-section')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(groupRows).toEqual([]);
    // The group's members keep their placement rows, ungrouped.
    expect(placementRows).toEqual([
      expect.objectContaining({ groupId: null, threadId: 'thread-b' }),
    ]);
  });

  it('moves a thread into a group from the context menu', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.contextMenu(screen.getByText('First thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Research' }));

    await waitFor(() => {
      expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    });
    expect(placementRows).toEqual([
      expect.objectContaining({
        groupId: 'group-research',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        threadId: 'thread-a',
      }),
    ]);
  });

  it('removes a thread from its group from the context menu', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.contextMenu(screen.getByText('Second thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Group' }));

    await waitFor(() => {
      expect(screen.getByText('Second thread').closest('tr')).toHaveAttribute('data-depth', '1');
    });
  });

  it('changes sorting from the view options popover', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const initialTitles = screen
      .getAllByTestId('thread-row')
      .map((row) => within(row).getByText(/thread/iu).textContent);
    expect(initialTitles).toEqual(['Second thread', 'First thread']);

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Name' }));

    await waitFor(() => {
      const titles = screen
        .getAllByTestId('thread-row')
        .map((row) => within(row).getByText(/thread/iu).textContent);
      expect(titles).toEqual(['First thread', 'Second thread']);
    });
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('name');
  });

  it('hides group sections when grouping is set to none', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'No grouping' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-group-section')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('none');
  });
});

describe('ThreadsPanel dates and pins', () => {
  beforeEach(() => {
    useAssistantThreadGroupsStore.setState({ groupBy: 'date' });
  });

  it('groups by date, newest conversation first', async () => {
    threadRows.unshift({
      createdAt: new Date(),
      id: 'thread-today',
      metadata: null,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Fresh thread',
      updatedAt: new Date(),
    });

    renderThreadsPanel();

    await screen.findByText('Fresh thread');
    const sections = screen.getAllByTestId('thread-date-section');
    expect(sections.map((section) => section.textContent)).toEqual([
      expect.stringContaining('Today'),
      expect.stringContaining('April'),
    ]);
    const titles = screen
      .getAllByTestId('thread-row')
      .map((row) => within(row).getByText(/thread/iu).textContent);
    expect(titles).toEqual(['Fresh thread', 'Second thread', 'First thread']);
  });

  it('pins a thread above the dates durably, and unpins it back into its date', async () => {
    renderThreadsPanel();

    await screen.findByText('First thread');
    expect(screen.queryByTestId('threads-pinned-section')).toBeNull();
    fireEvent.contextMenu(screen.getByText('First thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));

    const pinned = await screen.findByTestId('threads-pinned-section');
    expect(pinned).toHaveTextContent('Pinned');
    const titles = screen
      .getAllByTestId('thread-row')
      .map((row) => within(row).getByText(/thread/iu).textContent);
    expect(titles).toEqual(['First thread', 'Second thread']);
    expect(
      within(screen.getByText('First thread').closest('tr') as HTMLElement).getByTestId(
        'thread-pinned-marker'
      )
    ).toHaveAccessibleName('Pinned');
    expect(pinRows).toEqual([
      expect.objectContaining({ resourceId: WORKSPACE_MEMORY_RESOURCE_ID, threadId: 'thread-a' }),
    ]);

    fireEvent.contextMenu(screen.getByText('First thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));

    await waitFor(() => {
      expect(screen.queryByTestId('threads-pinned-section')).toBeNull();
    });
    expect(pinRows).toEqual([]);
    const after = screen
      .getAllByTestId('thread-row')
      .map((row) => within(row).getByText(/thread/iu).textContent);
    expect(after).toEqual(['Second thread', 'First thread']);
  });
});

/** A folder a thread is bound to, as its `roots` record reaches the panel. */
interface BoundRoot {
  readonly displayName: string;
  readonly id: string;
  readonly path: string;
  readonly projectId: string | null;
  /** The name the person gave its project; none unless a test names one. */
  readonly projectName?: string;
  /** A folder the host made for a thread sent with no folder open, as its record marks it. */
  readonly scratch?: true;
  /** Mounted unless a test disconnects it. */
  readonly status?: 'live' | 'disconnected';
}

describe('ThreadsPanel folders', () => {
  const WORKSPACE_ROOT: BoundRoot = {
    displayName: 'workspace-a',
    id: 'root-1',
    path: '/tmp/workspace-a',
    projectId: 'project-workspace-a',
  };

  function bindThreadToRoot(threadId: string, root: BoundRoot = WORKSPACE_ROOT): void {
    const row = threadRows.find((candidate) => candidate['id'] === threadId);
    if (!row) {
      throw new Error(`Cannot bind unknown thread ${threadId}.`);
    }
    row['metadata'] = JSON.stringify({
      ...parseMetadataObject(row['metadata']),
      operatingRootDisplayName: root.displayName,
      operatingRootId: root.id,
      operatingRootPath: root.path,
    });
    if (!rootRows.some((candidate) => candidate['id'] === root.id)) {
      rootRows.push({
        displayName: root.displayName,
        id: root.id,
        path: root.path,
        projectId: root.projectId,
        ...(root.projectName === undefined ? {} : { projectName: root.projectName }),
        ...(root.status === undefined ? {} : { status: root.status }),
        ...(root.scratch ? { scratch: true } : {}),
      });
    }
  }

  // A managed worktree's root has no project of its own: it is a checkout of its repository.
  const WORKTREE_ROOT: BoundRoot = {
    displayName: 'swift-badger',
    id: 'root-worktree',
    path: '/tmp/worktrees/swift-badger',
    projectId: null,
  };
  const WORKTREE_ID = 'worktree-1';

  /** Moves a thread into the managed worktree, as the host's binding records it. */
  function bindThreadToWorktree(threadId: string): void {
    bindThreadToRoot(threadId, WORKTREE_ROOT);
    const row = threadRows.find((candidate) => candidate['id'] === threadId);
    if (!row) {
      throw new Error(`Cannot bind unknown thread ${threadId}.`);
    }
    row['metadata'] = JSON.stringify({
      ...parseMetadataObject(row['metadata']),
      checkoutLocalRootId: WORKSPACE_ROOT.id,
      checkoutMode: 'worktree',
      checkoutWorktreeId: WORKTREE_ID,
      checkoutWorktreePath: WORKTREE_ROOT.path,
    });
  }

  /** One entry of the host's worktree listing; `workspace-a` is the repository. */
  function listed(overrides: Partial<WorktreeListEntry>): WorktreeListEntry {
    return {
      branch: 'main',
      containment: 'outside-roots',
      createdAt: null,
      detached: false,
      disabledReason: null,
      externalTool: null,
      id: null,
      lockedReason: null,
      managed: false,
      name: 'workspace-a',
      path: WORKSPACE_ROOT.path,
      primary: false,
      projectId: null,
      projectName: null,
      provenance: 'scanned',
      remedy: null,
      repoCommonDir: `${WORKSPACE_ROOT.path}/.git`,
      repositoryRoot: WORKSPACE_ROOT.path,
      rootId: null,
      rootIdIsExactMount: false,
      setupReason: null,
      setupStatus: 'none',
      trust: 'validated',
      trustReason: null,
      usable: true,
      ...overrides,
    };
  }
  const OWN_CHECKOUT = listed({
    primary: true,
    rootId: WORKSPACE_ROOT.id,
    rootIdIsExactMount: true,
  });
  const MANAGED_WORKTREE = listed({
    branch: 'swift-badger',
    id: WORKTREE_ID,
    managed: true,
    name: 'swift-badger',
    path: WORKTREE_ROOT.path,
    provenance: 'both',
    rootId: WORKTREE_ROOT.id,
    rootIdIsExactMount: true,
  });

  function rowFor(title: string): HTMLElement {
    const row = within(screen.getByRole('treegrid'))
      .getByText(title)
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!row) {
      throw new Error(`Expected a rendered row for ${title}.`);
    }
    return row;
  }

  async function enterFolderGrouping(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Project' }));
    await screen.findAllByTestId('thread-folder-count');
  }

  it('lists threads by where they work until another view is chosen', async () => {
    // What a person who has never touched View options sees.
    useAssistantThreadGroupsStore.getState().reset();
    bindThreadToRoot('thread-a');

    renderThreadsPanel();

    const sections = await screen.findAllByTestId('thread-folder-header');
    expect(sections.map((section) => section.textContent)).toEqual([
      expect.stringContaining('workspace-a'),
      expect.stringContaining('No project'),
    ]);
    expect(screen.queryByTestId('thread-date-section')).toBeNull();
    // The default view is not a changed one.
    expect(screen.queryByTestId('threads-view-options-dot')).toBeNull();
  });

  it('groups threads by their bound workspace folder with a trailing No project section', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const sections = screen.getAllByTestId('thread-group-section');
    expect(sections).toHaveLength(2);
    const folderSection = sections[0] as HTMLElement;
    const unassignedSection = sections[1] as HTMLElement;
    expect(within(folderSection).getByText('workspace-a')).toBeVisible();
    expect(within(folderSection).getByTestId('thread-folder-count')).toHaveTextContent('1');
    expect(within(unassignedSection).getByText('No project')).toBeVisible();
    expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('folder');
    // A folder is not a custom group, and "No project" is not a folder: there is
    // nothing for a new thread there to be bound to.
    expect(
      within(unassignedSection).queryByTestId('thread-folder-new-thread')
    ).not.toBeInTheDocument();
    expect(within(folderSection).getByTestId('thread-folder-new-thread')).toBeVisible();
  });

  // ADR-0034 scratch threads: each works in a folder of its own the host made, and a section
  // per folder would list each as a project.
  it('lists every scratch thread in one Scratch section with no New thread here, each row chipped with its folder', async () => {
    const quietOtter: BoundRoot = {
      displayName: 'quiet-otter',
      id: 'root-quiet-otter',
      path: '/profile/scratch/quiet-otter',
      projectId: null,
      scratch: true,
    };
    const amberFox: BoundRoot = {
      displayName: 'amber-fox',
      id: 'root-amber-fox',
      path: '/profile/scratch/amber-fox',
      projectId: null,
      scratch: true,
    };
    threadRows.push({
      createdAt: new Date('2026-04-22T08:00:00Z'),
      id: 'thread-c',
      metadata: null,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Third thread',
      updatedAt: new Date('2026-04-22T08:00:00Z'),
    });
    bindThreadToRoot('thread-a');
    bindThreadToRoot('thread-b', quietOtter);
    bindThreadToRoot('thread-c', amberFox);
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(3);
    });

    await enterFolderGrouping();

    const headers = screen.getAllByTestId('thread-folder-header');
    expect(headers).toHaveLength(2);
    const [project, scratch] = headers as [HTMLElement, HTMLElement];
    expect(within(project).getByText('workspace-a')).toBeVisible();
    // One section for both, after the project, not one named by each folder.
    expect(within(scratch).getByText('Scratch')).toBeVisible();
    expect(within(scratch).getByTestId('thread-folder-count')).toHaveTextContent('2');
    expect(within(scratch).getByTestId('thread-folder-scratch-icon')).toBeInTheDocument();
    expect(screen.getByText('Second thread').closest('tr')).toHaveAttribute('data-depth', '1');
    // A new scratch thread starts from New thread with no folder open, not from this section.
    expect(within(scratch).queryByTestId('thread-folder-new-thread')).not.toBeInTheDocument();
    expect(within(project).getByTestId('thread-folder-new-thread')).toBeVisible();
    // Each row names its own folder, so two scratch threads are told apart.
    const quietChip = within(rowFor('Second thread')).getByTestId('thread-checkout-chip');
    expect(quietChip).toHaveTextContent('quiet-otter');
    expect(quietChip).toHaveAttribute(
      'title',
      'Scratch folder quiet-otter at /profile/scratch/quiet-otter'
    );
    expect(within(rowFor('Third thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'amber-fox'
    );
    expect(within(rowFor('First thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'Local'
    );
  });

  // `collapsedGroupIds` is persisted, and folder sections mint their own keys.
  // Group keys are pruned when their group is deleted; nothing pruned a folder
  // key when the root behind it went away.
  it('prunes collapse keys for roots that no longer have a folder section', async () => {
    bindThreadToRoot('thread-a');
    act(() => {
      useAssistantThreadGroupsStore.setState({
        collapsedGroupIds: {
          'folder-scratch': true,
          'folder-unassigned': true,
          'folder:root-1': true,
          'folder:root-deleted': true,
          'group-research': true,
        },
      });
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    await waitFor(() => {
      expect(
        useAssistantThreadGroupsStore.getState().collapsedGroupIds['folder:root-deleted']
      ).toBeUndefined();
    });
    const collapsed = useAssistantThreadGroupsStore.getState().collapsedGroupIds;
    expect(collapsed['folder:root-1']).toBe(true);
    expect(collapsed['folder-unassigned']).toBe(true);
    // The Scratch section's key names no root, so no root going away prunes it.
    expect(collapsed['folder-scratch']).toBe(true);
    expect(collapsed['group-research']).toBe(true);
  });

  it('renders a groupBy already rehydrated as folder instead of throwing on first paint', async () => {
    bindThreadToRoot('thread-a');
    // Persistence has accepted 'folder' since BST-1403, so the render path must
    // honor it on MOUNT, not only when the popover switches into it.
    act(() => {
      useAssistantThreadGroupsStore.setState({ groupBy: 'folder' });
    });

    expect(() => renderThreadsPanel()).not.toThrow();

    expect((await screen.findAllByTestId('thread-folder-count')).length).toBeGreaterThan(0);
  });

  // BST-2493: a "Loading projects…" card stood in for the list whenever a thread got a new folder,
  // so every row unmounted and a menu open on any of them closed.
  it('keeps the list, and a row menu open on it, while a thread’s new folder is read', async () => {
    bindThreadToRoot('thread-a');
    const { threadGroups: transport } = window as unknown as {
      readonly threadGroups: {
        readonly readRoots: () => Promise<unknown>;
        readonly request: (input: unknown) => Promise<unknown>;
      };
    };
    const heldReads: (() => void)[] = [];
    let holdReads = false;
    Object.defineProperty(window, 'threadGroups', {
      configurable: true,
      value: {
        readRoots: async () => {
          if (holdReads) {
            await new Promise<void>((release) => heldReads.push(release));
          }
          return transport.readRoots();
        },
        request: transport.request,
      },
    });
    const host = createDefaultHost();
    renderThreadsPanel(host);
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Thread actions First thread' }));
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();

    // The host makes the other thread a scratch folder, as a first send with none open does.
    holdReads = true;
    bindThreadToRoot('thread-b', {
      displayName: 'quiet-otter',
      id: 'root-quiet-otter',
      path: '/profile/scratch/quiet-otter',
      projectId: null,
      scratch: true,
    });
    await act(async () => {
      await useAssistantThreadStore
        .getState()
        .refreshResourceThreads(
          createHostAssistantThreadRepository(host),
          WORKSPACE_MEMORY_RESOURCE_ID
        );
    });
    await waitFor(() => {
      expect(heldReads).not.toHaveLength(0);
    });

    expect(screen.queryByTestId('threads-folders-loading-card')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();

    await act(async () => {
      for (const release of heldReads) {
        release();
      }
    });
    // The open menu hides the treegrid from role queries, so the row is found by its title.
    const secondRow = screen
      .getByText('Second thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!secondRow) {
      throw new Error('Expected a rendered row for Second thread.');
    }
    await waitFor(() => {
      expect(within(secondRow).getByTestId('thread-checkout-chip')).toHaveTextContent(
        'quiet-otter'
      );
    });
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
  });

  it('offers folder sort without Custom and drives folderSortBy', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToRoot('thread-b');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(await screen.findByRole('radio', { name: 'Custom' })).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: 'Project' }));

    // Folder sections have no manual order, so Custom is not on offer there.
    expect(screen.queryByRole('radio', { name: 'Custom' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Name' }));
    expect(useAssistantThreadGroupsStore.getState().folderSortBy).toBe('name');
    // The manual-order presentations keep their own preference untouched.
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('recency');
    await waitFor(() => {
      const titles = screen
        .getAllByTestId('thread-row')
        .map((row) => within(row).getByText(/thread/iu).textContent);
      expect(titles).toEqual(['First thread', 'Second thread']);
    });
  });

  it('narrows the list to running threads through the Show only filters', async () => {
    leaveFixtureRunsUnseen();
    setHostRuns(['thread-b']);
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The three boxes are ONE labelled group, not loose checkboxes that happen
    // to sit under a heading: a screen reader announces "Show only" when focus
    // enters, which is the only thing that says these narrow the list.
    const showOnly = await screen.findByRole('group', { name: 'Show only' });
    expect(within(showOnly).getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.click(within(showOnly).getByRole('checkbox', { name: 'Running' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    const tree = within(screen.getByRole('treegrid'));
    expect(tree.getByText('Second thread')).toBeVisible();
    expect(tree.queryByText('First thread')).not.toBeInTheDocument();
    // The filter narrows the list, never what waits: the strip still names the
    // thread that finished unseen.
    expect(
      within(screen.getByRole('region', { name: 'Needs you' })).getByText('First thread')
    ).toBeVisible();
    expect(useAssistantThreadGroupsStore.getState().threadFilters.running).toBe(true);
    // The trigger's dot reports a narrowed list, not only a non-default sort.
    expect(screen.getByTestId('threads-view-options-dot')).toBeInTheDocument();

    // Two filters read as OR, not AND: ticking Unseen widens the list again.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unseen' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
  });

  it('names the filters when they hide every thread instead of showing an empty tree', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Needs you' }));

    expect(await screen.findByTestId('threads-filtered-empty-card')).toBeVisible();
    expect(screen.queryByTestId('thread-row')).not.toBeInTheDocument();
  });

  it('shows a needs-you glyph that outranks the running spinner', async () => {
    leaveFixtureRunsUnseen();
    setHostRuns(['thread-b'], ['thread-b']);
    renderThreadsPanel();

    const needsYou = await screen.findByTestId('thread-needs-you-glyph');
    expect(needsYou).toHaveAccessibleName('Second thread needs your approval');
    expect(within(rowFor('Second thread')).queryByTestId('thread-active-spinner')).toBeNull();
  });

  // The fresh-install / post-upgrade storm: with no watermark for any thread,
  // an unfloored derivation dots EVERY thread that ever finished a run.
  it('paints no unseen dot for runs that completed before the store existed', async () => {
    useAssistantThreadStore.setState({
      unseenBaselineAt: new Date('2026-04-22T12:00:00Z').getTime(),
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    expect(screen.queryAllByTestId('thread-unseen-glyph')).toHaveLength(0);
    expect(screen.queryAllByTestId('thread-failed-glyph')).toHaveLength(0);
  });

  // BST-1845: "seen" is a fact about the SCREEN, and only the surface that
  // renders transcripts can report it (`onScreenThreadId`). A Threads panel
  // mounted without that surface has nothing on screen — so even the row it has
  // selected carries its dot.
  it('marks every finished thread unseen, the selected one included, while nothing is on screen', async () => {
    leaveFixtureRunsUnseen();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(2);
    });
    expect(within(rowFor('Second thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toHaveAccessibleName(
      'First thread has unseen activity'
    );
  });

  it('exempts only the thread the transcript surface reports on screen', async () => {
    leaveFixtureRunsUnseen();
    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-b');
    });
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(1);
    });
    expect(within(rowFor('Second thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();

    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-a');
    });

    await waitFor(() => {
      expect(within(rowFor('First thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    });
    expect(within(rowFor('Second thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
  });

  // The Threads panel renders no transcript, so selecting a row there shows the
  // user nothing to have "seen". The transcript surface is the only stamper.
  it('never stamps the viewed watermark itself when a row is selected', async () => {
    leaveFixtureRunsUnseen();
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(2);
    });

    fireEvent.click(within(rowFor('First thread')).getByText('First thread'));

    await waitFor(() => {
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-a',
      });
    });
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({});
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
  });

  it('chips where each thread works in every grouping, without reading git', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    threadRows.push({
      createdAt: new Date('2026-04-22T08:00:00Z'),
      id: 'thread-c',
      metadata: null,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Third thread',
      updatedAt: new Date('2026-04-22T08:00:00Z'),
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(3);
    });

    // Custom groups here; the chip is the thread's own binding, so no grouping
    // has to pay for a repository scan to show it.
    expect(within(rowFor('First thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'Local'
    );
    expect(within(rowFor('Second thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'swift-badger'
    );
    // No folder, so nowhere it works yet.
    expect(within(rowFor('Third thread')).queryByTestId('thread-checkout-chip')).toBeNull();
    expect(gitMocks.list).not.toHaveBeenCalled();
  });

  it("lists a worktree's thread under its repository, beside the thread in the repository's own checkout", async () => {
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    gitMocks.list.mockResolvedValue({ ok: true, value: [OWN_CHECKOUT, MANAGED_WORKTREE] });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    // ONE section: the repository, not its checkout and its worktree apart.
    const headers = screen.getAllByTestId('thread-folder-header');
    expect(headers).toHaveLength(1);
    const repository = headers[0] as HTMLElement;
    expect(within(repository).getByText('workspace-a')).toBeVisible();
    expect(within(repository).getByTestId('thread-folder-count')).toHaveTextContent('2');
    // The header carries the branch the repository's own checkout is on.
    expect(within(repository).getByTestId('thread-folder-branch')).toHaveTextContent('main');
    expect(within(rowFor('First thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'Local'
    );
    expect(within(rowFor('Second thread')).getByTestId('thread-checkout-chip')).toHaveTextContent(
      'swift-badger'
    );
    // One listing for the whole panel, however many rows it places.
    expect(gitMocks.list).toHaveBeenCalledTimes(1);

    // "New thread here" starts in the repository's own checkout.
    fireEvent.click(within(repository).getByTestId('thread-folder-new-thread'));
    expect(
      useAssistantThreadStore.getState().newThreadMetadataByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toMatchObject({ operatingRootId: WORKSPACE_ROOT.id });
  });

  it('keeps a worktree as a folder of its own once git no longer joins it to the repository', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    gitMocks.list.mockResolvedValue({
      ok: true,
      value: [
        OWN_CHECKOUT,
        { ...MANAGED_WORKTREE, trust: 'unvalidated', trustReason: 'names another repository' },
      ],
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const names = screen
      .getAllByTestId('thread-folder-header')
      .map((header) => header.textContent ?? '');
    expect(names).toHaveLength(2);
    expect(names[0]).toContain('swift-badger');
    expect(names[1]).toContain('workspace-a');
  });

  it('says the repositories could not be read, and still groups by folder', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    gitMocks.list.mockResolvedValue({
      error: {
        category: 'internal',
        code: 'git.command-failed',
        kind: 'fault',
        message: 'git worktree list failed',
      },
      ok: false,
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    expect(await screen.findByTestId('thread-repositories-error')).toHaveTextContent(
      'git worktree list failed'
    );
    // Each thread under the folder it names: nothing is placed by a guess.
    expect(screen.getAllByTestId('thread-folder-header')).toHaveLength(2);
    expect(screen.queryByTestId('thread-folder-branch')).toBeNull();
  });

  it('holds the sections until the repositories have been read', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    let answer: (result: BoundaryResult<readonly WorktreeListEntry[]>) => void = () => undefined;
    gitMocks.list.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Project' }));

    // Drawing folders first would show the worktree as a section of its own,
    // then move its thread once the listing answered.
    expect(await screen.findByTestId('threads-folders-loading-card')).toBeVisible();
    expect(screen.queryByTestId('thread-folder-header')).toBeNull();

    await act(async () => {
      answer({ ok: true, value: [OWN_CHECKOUT, MANAGED_WORKTREE] });
    });

    expect(await screen.findAllByTestId('thread-folder-header')).toHaveLength(1);
  });

  it('groups by folder alone where the host serves no worktrees', async () => {
    gitMocks.available = false;
    bindThreadToRoot('thread-a');
    bindThreadToWorktree('thread-b');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    expect(screen.getAllByTestId('thread-folder-header')).toHaveLength(2);
    expect(screen.queryByTestId('thread-repositories-error')).toBeNull();
  });

  // ADR-0034 build decisions: a project is named, a folder joins another project as the person
  // chooses, and a folder that moved is located.
  describe('projects', () => {
    const OTHER_ROOT: BoundRoot = {
      displayName: 'workspace-b',
      id: 'root-2',
      path: '/tmp/workspace-b',
      projectId: 'project-workspace-b',
    };

    /** A host whose project changes rewrite the fixture's root records, as the store does. */
    function hostWithProjects(overrides: Partial<AssistantHostProjects> = {}) {
      const projects = {
        join: vi.fn<AssistantHostProjects['join']>(async (folder, projectId) => {
          const named = rootRows.find((row) => row['projectId'] === projectId)?.['projectName'];
          const rootId = 'rootId' in folder ? folder.rootId : null;
          for (const row of rootRows.filter((candidate) => candidate['id'] === rootId)) {
            row['projectId'] = projectId;
            row['projectName'] = named ?? null;
          }
        }),
        locate: vi.fn<AssistantHostProjects['locate']>(async () => null),
        rename: vi.fn<AssistantHostProjects['rename']>(async (project, name) => {
          const projectId = 'projectId' in project ? project.projectId : null;
          for (const row of rootRows.filter((candidate) => candidate['projectId'] === projectId)) {
            row['projectName'] = name.trim() === '' ? null : name.trim();
          }
        }),
        ...overrides,
      };
      return { host: { ...createDefaultHost(), projects }, projects };
    }

    function headers(): HTMLElement[] {
      return screen.getAllByTestId('thread-folder-header');
    }

    async function showProjects(host: AssistantThreadHostCapability): Promise<void> {
      renderThreadsPanel(host);
      await waitFor(() => {
        expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
      });
      await enterFolderGrouping();
    }

    async function openProjectActions(label: string): Promise<void> {
      fireEvent.click(await screen.findByRole('button', { name: `Project actions ${label}` }));
    }

    it("names a section by its project's name, once the person gave one", async () => {
      bindThreadToRoot('thread-a', { ...WORKSPACE_ROOT, projectName: 'Brainstrike app' });
      bindThreadToRoot('thread-b', OTHER_ROOT);

      await showProjects(hostWithProjects().host);

      // Named sections sort by their names: Brainstrike app before workspace-b.
      expect(headers().map((header) => header.textContent)).toEqual([
        expect.stringContaining('Brainstrike app'),
        expect.stringContaining('workspace-b'),
      ]);
      expect(within(headers()[0] as HTMLElement).queryByText('workspace-a')).toBeNull();
    });

    it("renames a project from its section's menu, and the section reads the new name", async () => {
      bindThreadToRoot('thread-a');
      const { host, projects } = hostWithProjects();
      await showProjects(host);

      await openProjectActions('workspace-a');
      fireEvent.click(await screen.findByRole('button', { name: 'Rename project…' }));
      const input = screen.getByRole('textbox', { name: 'Project name' });
      // Unnamed, so the field is empty; the folder's name says what an empty name means.
      expect(input).toHaveValue('');
      expect(input).toHaveAttribute('placeholder', 'workspace-a');
      fireEvent.change(input, { target: { value: 'Brainstrike app' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));

      await waitFor(() => {
        expect(projects.rename).toHaveBeenCalledWith(
          { projectId: 'project-workspace-a' },
          'Brainstrike app'
        );
      });
      expect(await within(headers()[0] as HTMLElement).findByText('Brainstrike app')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    });

    it("shows the host's refusal and keeps the name as typed", async () => {
      bindThreadToRoot('thread-a');
      const refused = new BoundaryFailureError(
        refusal({
          category: 'input',
          code: 'project.name-too-long',
          message: 'A project name is at most 80 characters, so the name was not changed.',
        })
      );
      const { host } = hostWithProjects({ rename: vi.fn(async () => Promise.reject(refused)) });
      await showProjects(host);

      await openProjectActions('workspace-a');
      fireEvent.click(await screen.findByRole('button', { name: 'Rename project…' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
        target: { value: 'x'.repeat(81) },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));

      expect(await screen.findByTestId('thread-project-action-error')).toHaveTextContent(
        'at most 80 characters'
      );
      expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('x'.repeat(81));
      expect(within(headers()[0] as HTMLElement).queryByText('workspace-a')).toBeNull();
    });

    it('moves a folder into another project the person chooses, and the two list in one section', async () => {
      bindThreadToRoot('thread-a');
      bindThreadToRoot('thread-b', OTHER_ROOT);
      const { host, projects } = hostWithProjects();
      await showProjects(host);
      expect(headers()).toHaveLength(2);

      await openProjectActions('workspace-b');
      fireEvent.click(await screen.findByRole('button', { name: 'Move to project…' }));
      const choices = within(screen.getByTestId('thread-project-move-list'));
      // The other listed projects only; nothing is joined by a guess.
      expect(choices.queryByRole('button', { name: 'workspace-b' })).toBeNull();
      fireEvent.click(choices.getByRole('button', { name: 'workspace-a' }));

      await waitFor(() => {
        expect(projects.join).toHaveBeenCalledWith({ rootId: 'root-2' }, 'project-workspace-a');
      });
      await waitFor(() => {
        expect(headers()).toHaveLength(1);
      });
      expect(
        within(headers()[0] as HTMLElement).getByTestId('thread-folder-count')
      ).toHaveTextContent('2');
    });

    // ADR-0034 build decisions (BST-2511, BST-2520): a repository found inside an open folder has no
    // project until the person names it or moves it, by its path; the listing then reads it. It is
    // not an open folder, so it is never located.
    it('names a repository found inside an open folder by its path, making its project, and moves it, with no Locate folder…', async () => {
      const CONTAINER: BoundRoot = {
        displayName: 'code',
        id: 'root-code',
        path: '/tmp/code',
        projectId: 'project-code',
      };
      const INNER = '/tmp/code/inner';
      bindThreadToRoot('thread-a', CONTAINER);
      bindThreadToWorktree('thread-b');
      let innerProject: { readonly id: string; readonly name: string | null } | null = null;
      gitMocks.list.mockImplementation(async () => ({
        ok: true,
        value: [
          listed({
            containment: [CONTAINER.id],
            name: 'inner',
            path: INNER,
            primary: true,
            projectId: innerProject?.id ?? null,
            projectName: innerProject?.name ?? null,
            repoCommonDir: `${INNER}/.git`,
            repositoryRoot: INNER,
            rootId: CONTAINER.id,
            rootIdIsExactMount: false,
          }),
          { ...MANAGED_WORKTREE, repoCommonDir: `${INNER}/.git`, repositoryRoot: INNER },
        ],
      }));
      const { host, projects } = hostWithProjects({
        // The host's store makes the repository's project on its first name.
        rename: vi.fn<AssistantHostProjects['rename']>(async (project, name) => {
          if ('repositoryPath' in project || project.projectId === 'project-inner') {
            innerProject = { id: 'project-inner', name: name.trim() === '' ? null : name.trim() };
          }
        }),
      });
      await showProjects(host);

      // The folder that holds it keeps its own project; the repository has none yet, and is
      // offered its first name and a move all the same.
      expect(headers().map((header) => header.textContent)).toEqual([
        expect.stringContaining('code'),
        expect.stringContaining('inner'),
      ]);
      await openProjectActions('inner');
      expect(await screen.findByRole('button', { name: 'Move to project…' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Locate folder…' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Rename project…' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
        target: { value: 'Inner library' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));
      await waitFor(() => {
        expect(projects.rename).toHaveBeenCalledWith({ repositoryPath: INNER }, 'Inner library');
      });
      // The section reads the name from the listing, read again once the rename committed; keyed
      // on its new project, it is drawn afresh.
      await waitFor(() => {
        expect(within(headers()[1] as HTMLElement).getByText('Inner library')).toBeVisible();
      });

      // Named now, it is renamed by its project.
      await openProjectActions('Inner library');
      fireEvent.click(await screen.findByRole('button', { name: 'Rename project…' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
        target: { value: 'Inner' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));
      await waitFor(() => {
        expect(projects.rename).toHaveBeenLastCalledWith({ projectId: 'project-inner' }, 'Inner');
      });
      expect(await within(headers()[1] as HTMLElement).findByText('Inner')).toBeVisible();

      await openProjectActions('Inner');
      fireEvent.click(await screen.findByRole('button', { name: 'Move to project…' }));
      fireEvent.click(
        within(screen.getByTestId('thread-project-move-list')).getByRole('button', {
          name: 'code',
        })
      );
      await waitFor(() => {
        expect(projects.join).toHaveBeenCalledWith({ repositoryPath: INNER }, 'project-code');
      });
    });

    // Scratch is where folderless threads work, not a project: nothing names it or moves into it.
    it('gives the Scratch section no project actions and never offers it as a project to move into', async () => {
      bindThreadToRoot('thread-a');
      bindThreadToRoot('thread-b', {
        displayName: 'quiet-otter',
        id: 'root-quiet-otter',
        path: '/profile/scratch/quiet-otter',
        projectId: null,
        scratch: true,
      });
      await showProjects(hostWithProjects().host);
      const [project, scratch] = headers() as [HTMLElement, HTMLElement];
      expect(within(scratch).getByText('Scratch')).toBeVisible();

      expect(within(scratch).queryByTestId('thread-project-actions')).toBeNull();
      await openProjectActions('workspace-a');
      fireEvent.click(await screen.findByRole('button', { name: 'Move to project…' }));
      const choices = within(screen.getByTestId('thread-project-move-list'));
      expect(choices.queryByRole('button', { name: 'Scratch' })).toBeNull();
      expect(within(project).getByTestId('thread-project-actions')).toBeVisible();
    });

    it('offers Locate folder… for a folder that is not mounted, and shows the folder it finds', async () => {
      bindThreadToRoot('thread-a', { ...WORKSPACE_ROOT, status: 'disconnected' });
      bindThreadToRoot('thread-b', OTHER_ROOT);
      const { host, projects } = hostWithProjects({
        locate: vi.fn<AssistantHostProjects['locate']>(async (rootId) => ({
          path: '/tmp/moved/workspace-a',
          rootId,
        })),
      });
      await showProjects(host);

      // A mounted folder is where its record says: there is nothing to locate.
      await openProjectActions('workspace-b');
      expect(await screen.findByRole('button', { name: 'Rename project…' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Locate folder…' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Project actions workspace-b' }));

      await openProjectActions('workspace-a');
      fireEvent.click(await screen.findByRole('button', { name: 'Locate folder…' }));

      await waitFor(() => {
        expect(projects.locate).toHaveBeenCalledWith('root-1');
      });
      await waitFor(() => {
        expect(fileExplorerMocks.addRootDirectoryByPath).toHaveBeenCalledWith(
          '/tmp/moved/workspace-a'
        );
      });
    });

    // The relink commits before the Explorer is asked to show the folder, so the section reads its
    // record again whatever the Explorer does: it stops offering Locate for a folder now found.
    it('reads a located folder again when the Explorer cannot show it, and says why', async () => {
      bindThreadToRoot('thread-a', { ...WORKSPACE_ROOT, status: 'disconnected' });
      bindThreadToRoot('thread-b', OTHER_ROOT);
      const { host } = hostWithProjects({
        locate: vi.fn<AssistantHostProjects['locate']>(async (rootId) => {
          for (const row of rootRows.filter((candidate) => candidate['id'] === rootId)) {
            row['path'] = '/tmp/moved/workspace-a';
            row['status'] = 'live';
          }
          return { path: '/tmp/moved/workspace-a', rootId };
        }),
      });
      fileExplorerMocks.addRootDirectoryByPath.mockRejectedValue(new Error('mount failed'));
      await showProjects(host);

      await openProjectActions('workspace-a');
      fireEvent.click(await screen.findByRole('button', { name: 'Locate folder…' }));

      expect(await screen.findByTestId('thread-project-action-error')).toHaveTextContent(
        'mount failed'
      );
      await openProjectActions('workspace-a');
      expect(await screen.findByRole('button', { name: 'Rename project…' })).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Locate folder…' })).toBeNull();
      });
    });

    // A refusal is about a project action: it goes with the rename form, and with Project grouping.
    it('clears a refusal when the rename is cancelled or the panel leaves Project grouping', async () => {
      bindThreadToRoot('thread-a');
      const refused = new BoundaryFailureError(
        refusal({
          category: 'input',
          code: 'project.name-too-long',
          message: 'A project name is at most 80 characters, so the name was not changed.',
        })
      );
      const { host } = hostWithProjects({ rename: vi.fn(async () => Promise.reject(refused)) });
      await showProjects(host);
      const refuse = async (): Promise<void> => {
        await openProjectActions('workspace-a');
        fireEvent.click(await screen.findByRole('button', { name: 'Rename project…' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
          target: { value: 'x'.repeat(81) },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));
        expect(await screen.findByTestId('thread-project-action-error')).toBeVisible();
      };

      await refuse();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel project rename' }));
      expect(screen.queryByTestId('thread-project-action-error')).toBeNull();

      await refuse();
      fireEvent.click(screen.getByRole('button', { name: 'View options' }));
      fireEvent.click(await screen.findByRole('radio', { name: 'No grouping' }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-project-action-error')).toBeNull();
      });
      // Back in Project grouping, the old refusal does not come back.
      fireEvent.click(await screen.findByRole('radio', { name: 'Project' }));
      await screen.findAllByTestId('thread-folder-count');
      expect(screen.queryByTestId('thread-project-action-error')).toBeNull();
    });

    it('offers no project actions where the host has none', async () => {
      bindThreadToRoot('thread-a');
      bindThreadToRoot('thread-b', OTHER_ROOT);

      await showProjects(createDefaultHost());

      expect(screen.queryByTestId('thread-project-actions')).toBeNull();
    });
  });

  it('lists what waits on the person above the sections, and lets a row go once it is seen', async () => {
    // The first thread finished before anyone looked; the second is held on its person.
    leaveFixtureRunsUnseen();
    setHostRuns(['thread-b'], ['thread-b']);
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const strip = screen.getByRole('region', { name: 'Needs you' });
    expect(
      within(strip)
        .getAllByTestId('threads-needs-you-row')
        .map((row) => row.textContent)
    ).toEqual(['Second threadWaiting on you', 'First threadReady to review']);
    // Above the sections: what waits shows before where it lives.
    const tree = screen.getByRole('treegrid');
    expect(strip.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A row opens its thread…
    fireEvent.click(within(strip).getByRole('button', { name: 'First thread: Ready to review' }));
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');

    // …and leaves once the thread has been shown, as its glyph does.
    act(() => {
      useAssistantThreadStore.getState().markThreadViewed('thread-a', Date.now());
    });
    await waitFor(() => {
      expect(within(strip).getAllByTestId('threads-needs-you-row')).toHaveLength(1);
    });

    // The held run is answered: nothing waits, so the strip goes.
    act(() => {
      useAssistantThreadStore.getState().markThreadViewed('thread-b', Date.now());
      setHostRuns([]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    });
  });

  // Drag-reorder rewrites the whole listed section's ranks. Under a filter the
  // rendered section is PARTIAL, so the rewrite would renumber the visible
  // threads and interleave them with the hidden ones' untouched ranks. The
  // affordance withdraws rather than lying, exactly as it does in folder mode.
  it('withdraws the row drag affordance while a Show only filter narrows the list', async () => {
    setHostRuns(['thread-b']);
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(rowFor('Second thread').closest('[draggable="true"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Running' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    expect(rowFor('Second thread').closest('[draggable="true"]')).toBeNull();
  });

  // The filtered-empty card told the user to "clear the filters in view
  // options" while the popover offered only the three individual boxes.
  it('offers the clear-filters control its filtered-empty card points at', async () => {
    // The default view, so only the filter can light the view options dot.
    useAssistantThreadGroupsStore.setState({ groupBy: 'folder' });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const showOnly = await screen.findByRole('group', { name: 'Show only' });
    // Nothing to clear yet: a control that cannot do anything is not offered.
    expect(within(showOnly).queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.click(within(showOnly).getByRole('checkbox', { name: 'Needs you' }));

    expect(await screen.findByTestId('threads-filtered-empty-card')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(useAssistantThreadGroupsStore.getState().threadFilters.needsYou).toBe(false);
    expect(screen.queryByTestId('threads-view-options-dot')).not.toBeInTheDocument();
  });

  // Every radio input carried NO `name`, so the browser treated all of them as
  // ONE implicit group per document: ArrowDown off the last "Group by" option
  // landed on the first "Sort by" option AND selected it, silently discarding
  // the user's sort. A distinct `name` per radiogroup makes the native
  // grouping match the ARIA grouping. JSDOM cannot dispatch real arrow-key
  // radio navigation (that is the browser's own behaviour, not the DOM's), so
  // this pins the CAUSE — the names — and the live re-check confirms the keys.
  it('gives each radiogroup its own native name so arrows cannot cross into another group', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const namesIn = (group: HTMLElement): Set<string> =>
      new Set(
        Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
          (input) => input.name
        )
      );

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));

    const groupBy = await screen.findByRole('radiogroup', { name: 'Group by' });
    const sortBy = screen.getByRole('radiogroup', { name: 'Sort by' });
    expect(namesIn(groupBy)).toEqual(new Set(['threads-group-by']));
    expect(namesIn(sortBy)).toEqual(new Set(['threads-sort-by']));

    // Folder mode swaps Sort by's options for the folder-only pair; they are a
    // different setting and must not share the recency/name group either.
    fireEvent.click(screen.getByRole('radio', { name: 'Project' }));

    await waitFor(() => {
      expect(namesIn(screen.getByRole('radiogroup', { name: 'Sort by' }))).toEqual(
        new Set(['threads-folder-sort'])
      );
    });
    expect(namesIn(screen.getByRole('radiogroup', { name: 'Group by' }))).toEqual(
      new Set(['threads-group-by'])
    );
  });

  it('paints a visible focus ring for every view-options radio and checkbox', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));

    const groupBy = await screen.findByRole('radiogroup', { name: 'Group by' });
    const sortBy = screen.getByRole('radiogroup', { name: 'Sort by' });
    const showOnly = screen.getByRole('group', { name: 'Show only' });
    const controls = [
      ...within(groupBy).getAllByRole('radio'),
      ...within(sortBy).getAllByRole('radio'),
      ...within(showOnly).getAllByRole('checkbox'),
    ];
    expect(controls.length).toBeGreaterThan(0);

    // JSDOM does not apply Tailwind, so these class names are the unit-level
    // contract; the live browser check verifies the rendered focus state.
    for (const control of controls) {
      const label = control.closest('label');
      if (!label) {
        throw new Error('View-option controls must be wrapped by labels.');
      }
      expect(label).toHaveClass(
        'has-[:focus-visible]:ring-2',
        'has-[:focus-visible]:ring-ring',
        'has-[:focus-visible]:ring-inset'
      );
    }
  });

  it('starts a new thread bound to the folder it was started from, creating nothing yet', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();

    fireEvent.click(screen.getByTestId('thread-folder-new-thread'));

    expect(
      useAssistantThreadStore.getState().newThreadMetadataByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual({
      operatingRootDisplayName: 'workspace-a',
      operatingRootId: 'root-1',
      operatingRootPath: '/tmp/workspace-a',
    });
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBeUndefined();
    // The first send creates the thread and commits the binding.
    expect(hostMocks.createThread).not.toHaveBeenCalled();
    expect(hostMocks.updateThreadBinding).not.toHaveBeenCalled();
  });

  it('offers neither drag handles nor group membership actions in folder grouping', async () => {
    bindThreadToRoot('thread-a');
    groupRows.push({
      color: null,
      icon: null,
      id: 'group-research',
      name: 'Research',
      rank: 'a0',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(rowFor('First thread').closest('[draggable="true"]')).not.toBeNull();

    await enterFolderGrouping();

    const folderRow = rowFor('First thread');
    // A folder is not a custom group: re-binding is the composer's Folders menu,
    // so the row offers no drag source and no membership actions.
    expect(folderRow.closest('[draggable="true"]')).toBeNull();
    fireEvent.contextMenu(screen.getByText('First thread'));
    expect(await screen.findByRole('menuitem', { name: 'Rename…' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Move to Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove from Group' })).not.toBeInTheDocument();
  });
});

describe('thread panel popover fixture lifetime', () => {
  let restoredFocus = false;

  afterAll(() => {
    expect(restoredFocus).toBe(true);
  });

  it('finishes focus restoration when a test leaves View options open', async () => {
    renderThreadsPanel();
    const trigger = screen.getByRole('button', { name: 'View options' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(trigger).not.toHaveFocus();
    trigger.addEventListener(
      'focus',
      () => {
        restoredFocus = true;
      },
      { once: true }
    );
    // The registered fixture teardown must close the real popover.
  });
});

it('loads host conversations, retained folders and custom groups', async () => {
  const thread: AssistantMemoryThread = {
    createdAt: new Date(),
    id: 'host-current',
    metadata: {
      operatingRootDisplayName: 'Retained',
      operatingRootId: 'retained-root',
      operatingRootPath: '/tmp/retained',
    },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Host current',
    updatedAt: new Date(),
  };
  const childThreads = vi.fn(async () => []);
  const host: AssistantThreadHostCapability = {
    childThreads,
    createThread: vi.fn(async () => thread),
    deleteThread: vi.fn(async () => [thread.id]),
    isHostThread: () => true,
    listThreads: vi.fn(async () => [thread]),
    ownsThread: vi.fn(async () => true),
    renameThread: vi.fn(),
    renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
    renderThread: () => null,
    subscribeChildren: () => () => undefined,
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
  const request = vi.fn(async () => ({
    groups: [
      {
        color: null,
        icon: null,
        id: 'thread-group-current',
        name: 'My work',
        rank: 'a0',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      },
    ],
    pins: [],
    placements: [
      {
        flatRank: null,
        groupId: 'thread-group-current',
        rank: 'a0',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        threadId: thread.id,
      },
    ],
  }));
  const readRoots = vi.fn(async () => [
    {
      displayName: 'Retained',
      id: 'retained-root',
      path: '/tmp/retained',
      projectId: 'project-retained',
      status: 'disconnected',
    },
  ]);
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: {
      readRoots: async () => ({ ok: true, value: await readRoots() }),
      request: async (...args: Parameters<typeof request>) => ({
        ok: true,
        value: await request(...args),
      }),
    },
  });
  renderThreadsPanel(host);
  const leaf = await screen.findByText('Host current');
  expect(leaf).toBeVisible();
  await waitFor(() => expect(childThreads).toHaveBeenCalledWith(thread.id));
  expect(
    within(leaf.closest('tr') as HTMLElement).queryByRole('button', { name: 'Expand' })
  ).toBeNull();
  expect(screen.queryByText('No child conversations')).toBeNull();
  expect(await screen.findByText('My work')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'View options' }));
  await userEvent.setup().click(screen.getByRole('radio', { name: 'Project' }));
  expect(await screen.findByText('Retained')).toBeVisible();
  expect(readRoots).toHaveBeenCalledTimes(1);
});
