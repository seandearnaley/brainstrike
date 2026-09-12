// @vitest-environment jsdom
import { loadDelegatedWorkspaceNode } from '../delegated-workspace-node';
import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { SubagentConversationNavigationContext } from '@brainstrike/assistant-ui';
import type { DelegatedConversationNode } from '@brainstrike/db';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { use } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { DelegatedWorkspaceNavigation } from '../delegated-workspace-navigation';
import { delegatedWorkspaceTabId } from '../delegated-workspace-tab';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';
import { useDelegatedWorkspaceApps } from '../use-delegated-workspace-apps';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

const mocks = vi.hoisted(() => ({ db: { query: vi.fn() }, get: vi.fn(), insights: vi.fn() }));
vi.mock('@brainstrike/db/react', () => ({
  useDbProviderError: () => null,
  usePGliteDatabase: () => mocks.db,
}));
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db')>()),
  createDelegatedConversationRepository: () => ({ get: mocks.get }),
  readDelegatedConversationInsights: mocks.insights,
}));
const address = { ownerResourceId: 'owner', rootThreadId: 'root', threadId: 'child' };
const node: DelegatedConversationNode = {
  ...address,
  color: 'emerald',
  configuration: {},
  createdAt: new Date('2026-09-10'),
  displayName: 'Cedar',
  parentThreadId: 'root',
  resourceId: 'native-child-resource',
  workspaceRootId: null,
};
const originalThreadState = useAssistantThreadStore.getState();
afterEach(() => {
  cleanup();
  __resetWorkspaceTabSelectionStoreForTests();
  useAssistantThreadStore.setState(originalThreadState, true);
  vi.clearAllMocks();
});

describe('delegated workspace app registration', () => {
  it('returns to the owning root without manufacturing a child tab for it', async () => {
    useWorkspaceTabSelectionStore.getState().hydrate([], { kind: 'empty' });
    function ReturnToRoot() {
      const navigate = use(SubagentConversationNavigationContext);
      return (
        <button onClick={() => navigate?.('root')} type="button">
          Return to root
        </button>
      );
    }
    render(
      <DelegatedConversationRootsProvider>
        <DelegatedWorkspaceNavigation ownerResourceId="owner" rootThreadId="root">
          <ReturnToRoot />
        </DelegatedWorkspaceNavigation>
      </DelegatedConversationRootsProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Return to root' }));
    expect(useAssistantThreadStore.getState().activeThreadIdByResourceId['owner']).toBe('root');
    expect(useWorkspaceTabSelectionStore.getState().openAppIds).toEqual([]);
  });

  it('keeps resolved app identities stable and loads only the newly opened child', async () => {
    mocks.get.mockImplementation(async (_scope, id) =>
      id === 'child' ? node : { ...node, displayName: 'Flint', threadId: 'second' }
    );
    const firstId = delegatedWorkspaceTabId(address);
    useWorkspaceTabSelectionStore.getState().openApp(firstId);
    const { result, rerender } = renderHook(useDelegatedWorkspaceApps);
    await waitFor(() => expect(result.current[0]?.label).toBe('Cedar'));
    const resolved = result.current;
    rerender();
    expect(result.current).toBe(resolved);
    act(() => {
      useWorkspaceTabSelectionStore
        .getState()
        .openApp(delegatedWorkspaceTabId({ ...address, threadId: 'second' }));
    });
    await waitFor(() => expect(result.current[1]?.label).toBe('Flint'));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('reauthorizes a closed child before showing cached metadata or reading its history', async () => {
    mocks.get.mockResolvedValueOnce(node);
    const id = delegatedWorkspaceTabId(address);
    useWorkspaceTabSelectionStore.getState().hydrate([id], { appId: id, kind: 'app' });
    const { result } = renderHook(useDelegatedWorkspaceApps);
    await waitFor(() => expect(result.current[0]?.label).toBe('Cedar'));
    act(() => {
      useWorkspaceTabSelectionStore.getState().closeApp(id);
    });
    mocks.get.mockImplementation(() => new Promise(() => undefined));
    act(() => {
      useWorkspaceTabSelectionStore.getState().openApp(id);
    });
    expect(result.current[0]?.label).toBe('Child conversation');
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it('opens the real child panel, closes it without execution, and reopens host output received while closed', async () => {
    mocks.get.mockResolvedValue(node);
    mocks.insights.mockResolvedValue({
      configuration: {
        maxSteps: 6,
        persona: {
          allowedToolIds: ['brainstrike.readWorkspaceFile'],
          description: 'Inspect',
          id: 'explore',
          instructions: 'Read the workspace.',
          label: 'Explorer',
          maxSteps: 6,
          mode: 'read-only',
        },
      },
      depth: 1,
      directUsage: null,
      latestRun: {
        model: 'child-model',
        modelSettings: null,
        provider: 'openai',
        providerOptions: null,
      },
      subtreeUsage: null,
      threadId: 'child',
    });
    useWorkspaceTabSelectionStore.getState().hydrate([], { kind: 'empty' });
    let publish: ((text: string) => void) | undefined;
    function OpenChild() {
      const open = use(SubagentConversationNavigationContext);
      return (
        <button onClick={() => open?.('child')} type="button">
          Open Cedar
        </button>
      );
    }
    function Harness() {
      const root = useDelegatedConversationRoot('owner', 'root');
      publish = (text) => root?.onDelegatedConversation(delegatedUpdate('child', 'initial', text));
      const apps = useDelegatedWorkspaceApps();
      return (
        <>
          <DelegatedWorkspaceNavigation ownerResourceId="owner" rootThreadId="root">
            <OpenChild />
          </DelegatedWorkspaceNavigation>
          {apps.map((app) => (
            <section key={app.id}>
              <h2>{app.label}</h2>
              <button
                onClick={() => useWorkspaceTabSelectionStore.getState().closeApp(app.id)}
                type="button"
              >
                Close {app.label}
              </button>
              {app.render()}
            </section>
          ))}
        </>
      );
    }
    render(
      <TooltipProvider>
        <DelegatedConversationRootsProvider>
          <Harness />
        </DelegatedConversationRootsProvider>
      </TooltipProvider>
    );
    act(() => {
      publish?.('First live child transcript.');
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open Cedar' }));
    expect(await screen.findByText('First live child transcript.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close Cedar' }));
    expect(screen.queryByText('First live child transcript.')).not.toBeInTheDocument();
    act(() => {
      publish?.('Finished while the child tab was closed.');
    });
    await user.click(screen.getByRole('button', { name: 'Open Cedar' }));
    expect(await screen.findByText('Finished while the child tab was closed.')).toBeVisible();
    expect(mocks.insights).toHaveBeenCalledWith(
      mocks.db,
      { ownerResourceId: 'owner', rootThreadId: 'root' },
      'child'
    );
    await user.click(screen.getByRole('button', { name: 'Child details' }));
    expect(await screen.findByText('child-model')).toBeVisible();
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it('requires the exact durable owner/root/child binding and child metadata', async () => {
    const get = vi.fn(async () => node);
    await expect(loadDelegatedWorkspaceNode({ get }, address)).resolves.toEqual(node);
    expect(get).toHaveBeenCalledWith(address, 'child');
    for (const invalid of [
      null,
      { ...node, ownerResourceId: 'other' },
      { ...node, rootThreadId: 'other' },
      { ...node, threadId: 'other' },
      { ...node, parentThreadId: null },
      { ...node, displayName: null },
      { ...node, color: null },
    ]) {
      await expect(
        loadDelegatedWorkspaceNode({ get: async () => invalid }, address)
      ).rejects.toThrow(/does not belong/);
    }
  });

  it('registers saved child ids immediately, resolves durable names, and closes via the existing store', async () => {
    let resolveNode: ((value: DelegatedConversationNode) => void) | undefined;
    mocks.get.mockImplementation(
      () =>
        new Promise<DelegatedConversationNode>((resolve) => {
          resolveNode = resolve;
        })
    );
    const id = delegatedWorkspaceTabId(address);
    useWorkspaceTabSelectionStore.getState().hydrate([id], { appId: id, kind: 'app' });
    const { result } = renderHook(useDelegatedWorkspaceApps);
    expect(result.current.map((app) => app.id)).toEqual([id]);
    expect(result.current[0]?.label).toBe('Child conversation');
    await act(async () => {
      resolveNode?.(node);
    });
    await waitFor(() => expect(result.current[0]?.label).toBe('Cedar'));
    expect(mocks.db.query).not.toHaveBeenCalled();
    act(() => {
      useWorkspaceTabSelectionStore.getState().closeApp(id);
    });
    expect(result.current).toEqual([]);
  });

  it('preserves a corrupt reserved tab as a visible error app without querying another conversation', () => {
    const id = 'delegated-conversation:%';
    useWorkspaceTabSelectionStore.getState().hydrate([id], { appId: id, kind: 'app' });
    const { result } = renderHook(useDelegatedWorkspaceApps);
    expect(result.current.map((app) => app.id)).toEqual([id]);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
