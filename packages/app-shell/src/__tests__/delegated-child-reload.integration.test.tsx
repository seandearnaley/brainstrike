import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createThreadWorkspaceRepository } from '@brainstrike/assistant-data';
import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { DelegatedConversationRoot } from '../delegated-conversation-owner';
import { createLiveWorkspaceFacade } from '../thread-workspace/thread-workspace-live-facade';
import { useThreadWorkspaceCoordinator } from '../thread-workspace/use-thread-workspace-coordinator';
import { useThreadSearchTitles } from '../use-thread-search-titles';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';
import '@testing-library/jest-dom/vitest';
import {
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-suspend';
import {
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  createDelegatedConversationRepository,
  readAssistantHistoryMessages,
  ThreadSearchRepository,
  ThreadSearchService,
  wasmLoader,
} from '@brainstrike/db';
import { type DbHandle, DbProvider, usePGliteDatabase } from '@brainstrike/db/react';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider, FileSystemProvider } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { ThemeProvider, TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { ChildView } from '../delegated-workspace-child-view';
import { type ChildNode, loadDelegatedWorkspaceNode } from '../delegated-workspace-node';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';
import { navigateThreadSearchResult } from '../navigate-thread-search-result';
import { useThreadSearchStore } from '../thread-search-store';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';
import { ThreadsPanelSearch } from '../threads-panel-search';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let node: ChildNode;
let workspace: ReturnType<typeof render>;
let databaseClosed: Promise<void>;
let storageAdapter: MemoryStorageAdapter;
let fileSystemAdapter: MockFileSystemAdapter;
let rootThreadId: string;
const append = vi.fn();
let activeRoot: DelegatedConversationRoot | undefined;
const identity = {
  childRuntimeRunId: 'child-run',
  parentRuntimeRunId: 'parent-run',
  parentToolCallId: 'child-call',
  personaId: 'explore',
};

// Mount the same workspace providers as AppLayout. The shared child composer
// resolves mentions and slash actions through these providers even before typing.
function WorkspaceProviders({ children }: { children: ReactNode }) {
  return (
    <DbProvider dbPath="memory://">
      <AdaptersProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
        <ThemeProvider defaultTheme="light" storageAdapter={storageAdapter}>
          <TooltipProvider>
            <FileExplorerProvider
              fileSystemAdapter={fileSystemAdapter}
              storageAdapter={storageAdapter}
            >
              <FileSystemProvider>{children}</FileSystemProvider>
            </FileExplorerProvider>
          </TooltipProvider>
        </ThemeProvider>
      </AdaptersProvider>
    </DbProvider>
  );
}

function DatabaseReady({ readiness }: { readiness: { resolve: () => void } }) {
  const db = usePGliteDatabase();
  useEffect(() => {
    if (!db) {
      return;
    }
    readiness.resolve();
  }, [db, readiness]);
  return null;
}

type RootThreadMessages = ReturnType<
  Parameters<DelegatedConversationRoot['onRuntimeReady']>[0]['thread']['getState']
>['messages'];
let rootMessages: RootThreadMessages = [];

function OwningRoot() {
  const root = useDelegatedConversationRoot('owner', rootThreadId);
  useEffect(() => {
    activeRoot = root;
    return root?.onRuntimeReady({
      thread: {
        append,
        getState: () => ({ isRunning: false, messages: rootMessages, threadId: rootThreadId }),
        subscribe: () => () => undefined,
      },
    });
  }, [root]);
  return null;
}

beforeEach(async () => {
  const createClient = wasmLoader.createPGliteClient.bind(wasmLoader);
  const closed = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  databaseClosed = closed.promise;
  vi.spyOn(wasmLoader, 'createPGliteClient').mockImplementationOnce(async (path) => {
    const client = await createClient(path);
    database = client as typeof database;
    const close = client.close.bind(client);
    vi.spyOn(client, 'close').mockImplementation(async () => {
      try {
        await close();
        closed.resolve();
      } catch (error) {
        closed.reject(error);
        throw error;
      }
    });
    return client;
  });
  storageAdapter = new MemoryStorageAdapter();
  fileSystemAdapter = new MockFileSystemAdapter();
  workspace = render(
    <WorkspaceProviders>
      <DatabaseReady readiness={ready} />
    </WorkspaceProviders>
  );
  await ready.promise;
  const history = createPgliteAssistantThreadRepository(database as DbHandle);
  const root = await history.createThread('owner');
  const child = await history.createThread('native-child');
  rootThreadId = root.id;
  await history.createThreadRun({
    id: 'host' as HostRunId,
    model: 'test',
    provider: 'openai',
    resourceId: 'owner',
    runtimeKind: 'hosted',
    status: 'completed',
    threadId: root.id,
    turnMessageId: 'root-user',
  });
  const graph = createDelegatedConversationRepository(database);
  const scope = { ownerResourceId: 'owner', rootThreadId: root.id };
  await graph.registerRoot(scope);
  await graph.createChild(scope, {
    color: 'emerald',
    configuration: {},
    displayName: 'Cedar',
    parentThreadId: root.id,
    resourceId: 'native-child',
    threadId: child.id,
  });
  await graph.createInvocation(scope, {
    ...identity,
    hostRunId: 'host',
    parentThreadId: root.id,
    threadId: child.id,
  });
  await graph.bindInvocationRun(scope, identity, identity.childRuntimeRunId);
  node = await loadDelegatedWorkspaceNode(graph, { ...scope, threadId: child.id });
  await database.query(
    `INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt") VALUES ('saved-child', $1, 'native-child', 'assistant', 'v2', $2, NOW())`,
    [
      child.id,
      JSON.stringify({
        format: 2,
        parts: [{ text: 'Persisted native child transcript.', type: 'text' }],
      }),
    ]
  );
  Object.defineProperty(window, 'assistant', {
    configurable: true,
    value: { url: 'http://assistant.test' },
  });
}, 30_000);

afterEach(async () => {
  cleanup();
  useThreadSearchStore.getState().reset();
  useWorkspaceTabSelectionStore.getState().reset();
  threadWorkspaceNavigation.loading('owner', null);
  activeRoot = undefined;
  Reflect.deleteProperty(window, 'assistant');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await databaseClosed;
  vi.restoreAllMocks();
});

describe('child view after renderer restart', () => {
  it('opens an older grandchild search match through the saved workspace and focuses it without execution', async () => {
    // happy-dom lacks scrolling. Real geometry is verified by the shared Chromium contract.
    const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? this.scrollTop;
      },
    });
    onTestFinished(() => {
      if (scrollDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ approvals: [], suspends: [] }))
    );
    const history = createPgliteAssistantThreadRepository(database as DbHandle);
    const leaf = await history.createThread('native-grandchild');
    const graph = createDelegatedConversationRepository(database);
    const scope = { ownerResourceId: 'owner', rootThreadId };
    await graph.createChild(scope, {
      color: 'blue',
      configuration: {},
      displayName: 'Maple',
      parentThreadId: node.threadId,
      resourceId: 'native-grandchild',
      threadId: leaf.id,
    });
    const leafNode = await loadDelegatedWorkspaceNode(graph, { ...scope, threadId: leaf.id });
    for (let index = 0; index < 110; index += 1) {
      await database.query(
        `INSERT INTO mastra_messages
        (id, thread_id, "resourceId", role, type, content, "createdAt")
        VALUES ($1, $2, 'native-grandchild', $3, 'v2', $4, $5)`,
        [
          `leaf-${String(index).padStart(3, '0')}`,
          leaf.id,
          index % 2 === 0 && index !== 10 ? 'user' : 'assistant',
          JSON.stringify({
            format: 2,
            parts: [
              {
                text: index === 9 ? 'quasarcobalt older match' : `leaf text ${index}`,
                type: 'text',
              },
            ],
          }),
          new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
        ]
      );
    }
    const repository = new ThreadSearchRepository(database);
    await repository.sync();
    const { results } = await new ThreadSearchService(repository).searchThreads('quasarcobalt', {
      queryEmbedding: null,
      resourceId: 'owner',
    });
    expect(results[0]?.matches[0]?.messageId).toBe('leaf-009');
    const initial = await history.listMessages(leaf.id, 'native-grandchild', {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    expect(initial.some((message) => message.id === 'leaf-009')).toBe(false);
    const search = useThreadSearchStore.getState();
    search.setQuery('quasarcobalt');
    search.resolveResults(results, { kind: 'unused' }, search.beginSearch());
    useAssistantComposerCommandStore.getState().recordDraft(rootThreadId, 'Unsent parent draft');
    const facade = createLiveWorkspaceFacade(createFileExplorerStore(new MemoryStorageAdapter()));
    const workspaceRepository = createThreadWorkspaceRepository(database as DbHandle);
    const appId = delegatedWorkspaceTabId(leafNode);
    function Workspace() {
      const titles = useThreadSearchTitles(repository, 'owner');
      const selected = useWorkspaceTabSelectionStore((state) => state.selection);
      const activeThreadId = useAssistantThreadStore(
        (state) => state.activeThreadIdByResourceId['owner'] ?? null
      );
      useThreadWorkspaceCoordinator({
        activeThreadId,
        facade,
        navigation: threadWorkspaceNavigation,
        openThreadIds: [rootThreadId],
        repository: workspaceRepository,
        resourceId: 'owner',
        subscribe: useWorkspaceTabSelectionStore.subscribe,
      });
      return (
        <>
          <OwningRoot />
          <ThreadsPanelSearch
            groupNameByThreadId={new Map()}
            onRetry={() => undefined}
            onSelectThread={(threadId, messageId) => {
              void navigateThreadSearchResult(repository, 'owner', threadId, messageId);
            }}
            threadsById={new Map()}
            titlesByThreadId={titles}
          />
          {selected.kind === 'app' && selected.appId === appId ? (
            <ChildView db={database as DbHandle} node={leafNode} />
          ) : null}
        </>
      );
    }
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <Workspace />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    const user = userEvent.setup();
    await screen.findByText('Maple');
    await user.click(screen.getByTestId('thread-search-result'));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-message-id')).toBe('leaf-011')
    );
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent('quasarcobalt older match')
    );
    expect(screen.getByRole('navigation', { name: 'Conversation ancestry' })).toHaveTextContent(
      /Cedar.*Maple/
    );
    expect(
      useWorkspaceTabSelectionStore.getState().openAppIds.filter((id) => id === appId)
    ).toHaveLength(1);
    expect(useAssistantThreadStore.getState().selectedThreadByResourceId['owner']).toBe(
      rootThreadId
    );
    expect(useThreadSearchStore.getState().navigationError).toBeNull();
    expect(useAssistantComposerCommandStore.getState().draftTextByThreadId[rootThreadId]).toBe(
      'Unsent parent draft'
    );
    expect(append).not.toHaveBeenCalled();
    act(() => {
      useWorkspaceTabSelectionStore.getState().closeApp(appId);
    });
    await user.click(screen.getByTestId('thread-search-result'));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-message-id')).toBe('leaf-011')
    );
    expect(append).not.toHaveBeenCalled();
  });

  it('does not resurrect an earlier search read when a new host baseline excludes its deleted message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ approvals: [], suspends: [] }))
    );
    await database.query(
      "UPDATE mastra_messages SET \"createdAt\" = '2026-09-10T00:00:00.000Z' WHERE id = 'saved-child'"
    );
    const prompt = {
      content: 'Later prompt.',
      createdAt: '2026-09-10T01:00:00.000Z',
      id: 'later-prompt',
      role: 'user',
    };
    await database.query(
      'INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        prompt.id,
        node.threadId,
        node.resourceId,
        prompt.role,
        'text',
        JSON.stringify(prompt.content),
        prompt.createdAt,
      ]
    );
    await database.query(
      'INSERT INTO mastra_messages (id, thread_id, "resourceId", role, type, content, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        'later-answer',
        node.threadId,
        node.resourceId,
        'assistant',
        'v2',
        JSON.stringify({ format: 2, parts: [{ text: 'Later durable answer.', type: 'text' }] }),
        '2026-09-10T02:00:00.000Z',
      ]
    );
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    await screen.findByText('Persisted native child transcript.');
    const publish = (hostRunId: string, text: string) => {
      const update = delegatedUpdate(node.threadId, hostRunId, text);
      if (!update.baseline) {
        throw new Error('Missing baseline');
      }
      activeRoot?.onDelegatedConversation({
        ...update,
        baseline: { ...update.baseline, messages: [prompt] },
      });
    };
    const nativeRows = await readAssistantHistoryMessages(database, node.threadId, node.resourceId);
    expect(nativeRows.map((row) => row.id)).toEqual([
      'saved-child',
      'later-prompt',
      'later-answer',
    ]);
    act(() => publish('before-rewind', 'Before rewind.'));
    act(() => {
      const state = useThreadSearchStore.getState();
      state.setNavigationTarget({
        messageId: 'saved-child',
        ownerResourceId: 'owner',
        requestId: state.beginNavigation(),
        threadId: node.threadId,
      });
    });
    await screen.findByText('Persisted native child transcript.');
    // Native history really changed. This is not compaction, which deliberately
    // retains raw messages in scrollback and only overlays the provider prompt.
    await database.query('DELETE FROM mastra_messages WHERE id = $1', ['saved-child']);
    act(() => publish('after-rewind', 'After rewind.'));
    await screen.findByText('After rewind.');
    expect(screen.queryByText('Persisted native child transcript.')).not.toBeInTheDocument();
    expect(append).not.toHaveBeenCalled();
  });

  it('reports an unreachable search target while keeping the child open and allowing a new target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ approvals: [], suspends: [] }))
    );
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    await screen.findByText('Persisted native child transcript.');
    act(() => {
      const state = useThreadSearchStore.getState();
      state.setNavigationTarget({
        messageId: 'removed-after-selection',
        ownerResourceId: 'owner',
        requestId: state.beginNavigation(),
        threadId: node.threadId,
      });
    });
    await waitFor(() =>
      expect(useThreadSearchStore.getState().navigationError).toMatch(/no longer available/)
    );
    expect(useThreadSearchStore.getState().navigationTarget).toBeNull();
    expect(screen.getByText('Persisted native child transcript.')).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });

  it('shows arriving host output before a pending recovery read settles', async () => {
    let settle: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        })
    );
    vi.stubGlobal('fetch', fetch);
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const messages = await readAssistantHistoryMessages(database, node.threadId, node.resourceId, {
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
    const update = delegatedUpdate(
      node.threadId,
      'new-host-leg',
      'Live output while recovery is pending.'
    );
    if (!update.baseline) {
      throw new Error('Missing test baseline');
    }
    const baseline = {
      ...update.baseline,
      messages: messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
      })),
    };
    act(() => {
      activeRoot?.onDelegatedConversation({ ...update, baseline });
    });
    expect(await screen.findByText('Live output while recovery is pending.')).toBeVisible();
    await act(async () => {
      settle?.(Response.json({ approvals: [], suspends: [] }));
    });
    expect(screen.getByText('Live output while recovery is pending.')).toBeVisible();
    expect(screen.getByText('Persisted native child transcript.')).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });
  it('renders the durable ancestry in the actual child view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ approvals: [], suspends: [] }))
    );
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    const trail = await screen.findByRole('navigation', { name: 'Conversation ancestry' });
    expect(within(trail).getByRole('button', { name: 'Main conversation' })).toBeVisible();
    expect(within(trail).getByText(node.displayName)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: node.displayName })).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });
  it('keeps native history visible when pending decision discovery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    );
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    expect(await screen.findByText('Persisted native child transcript.')).toBeVisible();
    expect(await screen.findByText('Pending decisions could not be restored')).toBeVisible();
    expect(append).not.toHaveBeenCalled();
  });

  it('keeps rich persisted history visible while an interrupted exact decision stays non-actionable', async () => {
    await database.query('UPDATE mastra_messages SET content = $1 WHERE id = $2', [
      JSON.stringify({
        format: 2,
        parts: [
          {
            text: 'Persisted native child transcript.\n\n## Saved read result\n\n[Evidence file](https://example.com/evidence.txt)\n\n```ts\nconst marker = 1720;\n```',
            type: 'text',
          },
        ],
      }),
      'saved-child',
    ]);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/assistant/suspended-runs');
      expect(url.searchParams.get('threadId')).toBe(rootThreadId);
      expect(url.searchParams.get('resourceId')).toBe('owner');
      return Response.json({
        approvals: [
          {
            args: { path: 'report.txt' },
            decisionState: 'interrupted',
            delegation: { path: [identity], toolCallId: 'leaf' },
            runId: identity.parentRuntimeRunId,
            stale: false,
            suspendedAt: '2026-09-10T00:00:00.000Z',
            toolCallId: identity.parentToolCallId,
            toolName: 'workspace.writeFile',
          },
        ],
        suspends: [],
      });
    });
    vi.stubGlobal('fetch', fetch);
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );

    expect(await screen.findByRole('heading', { name: 'Saved read result' })).toBeVisible();
    expect(screen.getByText('Persisted native child transcript.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Evidence file' })).toHaveAttribute(
      'href',
      'https://example.com/evidence.txt'
    );
    // A durable decision is answered, so it renders as a collapsed row
    // (SWARM-AWARE PRESENTATION). Its recovery status is readable before the
    // row opens; the locked buttons live in the row's expanded body.
    expect(screen.getByTestId('delegated-decision-recovery-status')).toHaveTextContent(
      'Decision interrupted. Processing stopped and the outcome is unknown.'
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /show approval details/i }));
    const approve = screen.getByRole('button', { name: 'Approve workspace.writeFile' });
    const decline = screen.getByRole('button', { name: 'Decline workspace.writeFile' });
    expect(approve).toBeDisabled();
    expect(decline).toBeDisabled();
    await user.click(approve);
    await user.click(decline);
    expect(append).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Saved read result' })).toBeVisible();
  });

  it.each(['approval', 'question'] as const)(
    'restores a native %s card and routes the click through the owning root',
    async (kind) => {
      const target = {
        delegation: { path: [identity], toolCallId: 'leaf' },
        runId: 'parent-run',
        toolCallId: 'child-call',
      };
      const common = { ...target, stale: false, suspendedAt: '2026-09-10T00:00:00.000Z' };
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/assistant/suspended-runs');
        expect(url.searchParams.get('threadId')).toBe(rootThreadId);
        expect(url.searchParams.get('resourceId')).toBe('owner');
        return Response.json({
          approvals:
            kind === 'approval'
              ? [{ ...common, args: { path: 'report.txt' }, toolName: 'workspace.writeFile' }]
              : [],
          suspends:
            kind === 'question'
              ? [
                  {
                    ...common,
                    suspendPayload: { question: 'Which language?' },
                    toolName: 'brainstrike.askUser',
                  },
                ]
              : [],
        });
      });
      vi.stubGlobal('fetch', fetch);
      workspace.rerender(
        <WorkspaceProviders>
          <DelegatedConversationRootsProvider>
            <OwningRoot />
            <ChildView db={database as DbHandle} node={node} />
          </DelegatedConversationRootsProvider>
        </WorkspaceProviders>
      );
      expect(await screen.findByText('Persisted native child transcript.')).toBeVisible();
      expect(append).not.toHaveBeenCalled();
      const user = userEvent.setup();
      if (kind === 'approval') {
        await user.click(
          await screen.findByRole('button', { name: /approve workspace.writefile/i })
        );
      } else {
        await user.type(await screen.findByRole('textbox', { name: /answer/i }), 'TypeScript');
        await user.click(
          within(screen.getByTestId('assistant-ask-user-notice')).getByRole('button', {
            name: /^send$/i,
          })
        );
      }
      await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
      const key = kind === 'approval' ? TOOL_APPROVAL_RUN_CONFIG_KEY : TOOL_SUSPEND_RUN_CONFIG_KEY;
      expect(append.mock.calls[0]?.[0]).toMatchObject({
        role: 'user',
        runConfig: {
          custom: {
            [key]: {
              ...target,
              ...(kind === 'approval'
                ? { action: 'approve' }
                : { resumeData: { answer: 'TypeScript' } }),
            },
          },
        },
        startRun: true,
      });
      expect(append.mock.calls[0]?.[0]).not.toHaveProperty('parentId');
      expect(append.mock.calls[0]?.[0]).not.toHaveProperty('sourceId');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('shows a child approval its owning root already answered as the answered row in the live child view', async () => {
    // Live GLM fan-out (2026-09-15): "Allow reads this session" answered every
    // parked read on the ROOT leg, yet each child tab kept a "Pending" card
    // with live buttons — the answer never streams into the child's own leg.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ approvals: [], suspends: [] }))
    );
    const delegation = { path: [identity], toolCallId: 'leaf-read' };
    const childNotice = {
      args: { path: 'README.md' },
      delegation,
      riskCategory: 'read',
      runId: identity.childRuntimeRunId,
      toolCallId: 'leaf-read',
      toolName: 'brainstrike.readWorkspaceFile',
    };
    const rootEdge = { runId: identity.parentRuntimeRunId, toolCallId: identity.parentToolCallId };
    rootMessages = [
      {
        content: [
          { data: { ...childNotice, ...rootEdge }, name: TOOL_APPROVAL_DATA_NAME, type: 'data' },
          {
            data: {
              decision: 'approve',
              delegation,
              reason: 'session-grant',
              ...rootEdge,
              toolName: 'brainstrike.readWorkspaceFile',
            },
            name: TOOL_APPROVAL_ANSWERED_DATA_NAME,
            type: 'data',
          },
        ],
        createdAt: new Date('2026-09-15T00:00:00.000Z'),
        id: 'root-turn',
        metadata: {
          custom: {},
          steps: [],
          unstable_annotations: [],
          unstable_data: [],
          unstable_state: null,
        },
        role: 'assistant',
        status: { type: 'running' },
      },
    ];
    onTestFinished(() => {
      rootMessages = [];
    });
    workspace.rerender(
      <WorkspaceProviders>
        <DelegatedConversationRootsProvider>
          <OwningRoot />
          <ChildView db={database as DbHandle} node={node} />
        </DelegatedConversationRootsProvider>
      </WorkspaceProviders>
    );
    expect(await screen.findByText('Persisted native child transcript.')).toBeVisible();
    const update = delegatedUpdate(node.threadId, 'answered-leg', 'Reading the README.');
    update.message.parts.push({ data: childNotice, name: TOOL_APPROVAL_DATA_NAME, type: 'data' });
    act(() => {
      activeRoot?.onDelegatedConversation({ ...update, identity });
    });
    const notice = await screen.findByTestId('assistant-tool-approval-notice');
    expect(notice).toHaveAttribute('data-approval-presentation', 'row');
    expect(within(notice).getByTestId('approval-row-status')).toHaveTextContent(
      'Allowed by session grant'
    );
    expect(
      screen.queryByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
    ).not.toBeInTheDocument();
    expect(append).not.toHaveBeenCalled();
  });
});
