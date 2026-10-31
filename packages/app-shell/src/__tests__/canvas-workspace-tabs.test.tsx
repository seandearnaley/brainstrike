import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act } from '@brainstrike/test-utils/react-act';
import { ThemeProvider } from '@brainstrike/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCanvasCommit,
  type AssistantThreadHostCanvasVersion,
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { canvasWorkspaceTabId } from '../canvas/canvas-workspace-tab';
import { useCanvasAutoOpen } from '../canvas/use-canvas-auto-open';
import { useCanvasWorkspaceApps } from '../canvas/use-canvas-workspace-apps';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';

type CanvasMap = ReadonlyMap<string, readonly AssistantThreadHostCanvasVersion[]>;

const SHELL = 'https://shell.invalid/canvas-frame.html';

function versions(canvasId: string, title: string, latest: number) {
  return Array.from(
    { length: latest },
    (_, index): AssistantThreadHostCanvasVersion => ({
      canvasId,
      createdAt: '2026-10-27T01:00:00.000Z',
      createdBy: 'assistant',
      html: `<p>${canvasId} v${index + 1}</p>`,
      title,
      version: index + 1,
    })
  );
}

const refused = (): Promise<never> => Promise.reject(new Error('not used by canvas tabs'));

function createHost(
  overrides: Partial<AssistantThreadHostCapability> = {}
): AssistantThreadHostCapability {
  return {
    createThread: refused,
    deleteThread: refused,
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderNewThread: () => null,
    renderThread: () => null,
    updateThreadBinding: refused,
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
    ...overrides,
  };
}

const themeStorageAdapter = {
  getItem: () => Promise.resolve('light'),
  removeItem: () => Promise.resolve(),
  setItem: () => Promise.resolve(),
};

/** The workspace's view of every open canvas tab: its label and its body. */
function CanvasTabs({ autoOpen = false }: { readonly autoOpen?: boolean }) {
  useCanvasAutoOpen(autoOpen);
  const apps = useCanvasWorkspaceApps(SHELL);
  return (
    <>
      {apps.map((app) => (
        <section aria-label={app.label} key={app.id}>
          {app.render()}
        </section>
      ))}
    </>
  );
}

function renderTabs(host: AssistantThreadHostCapability, autoOpen = false) {
  return render(
    <ThemeProvider storageAdapter={themeStorageAdapter}>
      <AssistantThreadHostContext.Provider value={host}>
        <CanvasTabs autoOpen={autoOpen} />
      </AssistantThreadHostContext.Provider>
    </ThemeProvider>
  );
}

function openCanvas(threadId: string, canvasId: string): string {
  const id = canvasWorkspaceTabId({ canvasId, threadId });
  useWorkspaceTabSelectionStore.getState().openApp(id);
  return id;
}

beforeEach(() => {
  resetAssistantThreadStore();
});

afterEach(() => {
  cleanup();
});

describe('canvas workspace tabs', () => {
  it('opens each canvas in its own tab, named after it, from one read of their thread', async () => {
    const readCanvases = vi.fn(
      async (): Promise<CanvasMap> =>
        new Map([
          ['chart', versions('chart', 'Revenue chart', 2)],
          ['report', versions('report', 'Q3 report', 3)],
        ])
    );
    openCanvas('thread-1', 'chart');
    openCanvas('thread-1', 'report');
    renderTabs(createHost({ readCanvases }));

    const chart = await screen.findByRole('region', { name: 'Revenue chart' });
    const report = screen.getByRole('region', { name: 'Q3 report' });
    expect(within(chart).getByTestId('canvas-version-label')).toHaveTextContent('v2 / 2');
    expect(within(report).getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    expect(within(chart).getByTitle('Canvas')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(readCanvases).toHaveBeenCalledTimes(1);
    expect(readCanvases).toHaveBeenCalledWith('thread-1');
  });

  it('steps each tab through its own versions independently', async () => {
    openCanvas('thread-1', 'chart');
    openCanvas('thread-1', 'report');
    renderTabs(
      createHost({
        readCanvases: async () =>
          new Map([
            ['chart', versions('chart', 'Chart', 2)],
            ['report', versions('report', 'Report', 3)],
          ]),
      })
    );
    const report = await screen.findByRole('region', { name: 'Report' });

    fireEvent.click(within(report).getByTestId('canvas-version-previous'));
    fireEvent.click(within(report).getByTestId('canvas-version-previous'));

    expect(within(report).getByTestId('canvas-version-label')).toHaveTextContent('v1 / 3');
    expect(within(report).getByTestId('canvas-version-previous')).toBeDisabled();
    const chart = screen.getByRole('region', { name: 'Chart' });
    expect(within(chart).getByTestId('canvas-version-label')).toHaveTextContent('v2 / 2');
  });

  it('reads the thread its address names, so a subagent canvas opens from the parent', async () => {
    const readCanvases = vi.fn(
      async (threadId: string): Promise<CanvasMap> =>
        threadId === 'child-1'
          ? new Map([['notes', versions('notes', 'Child notes', 1)]])
          : new Map()
    );
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'root-1' },
    });
    openCanvas('child-1', 'notes');
    renderTabs(createHost({ readCanvases }));

    expect(await screen.findByRole('region', { name: 'Child notes' })).toBeVisible();
    expect(readCanvases).toHaveBeenCalledWith('child-1');
    expect(readCanvases).not.toHaveBeenCalledWith('root-1');
  });

  it('follows a run that commits a new version while the tab is open', async () => {
    let latest = 1;
    const listeners = new Set<() => void>();
    renderTabs(
      createHost({
        readCanvases: async () =>
          new Map([['chart', versions('chart', `Chart v${latest}`, latest)]]),
        subscribeCanvases: (_threadId, listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      })
    );
    act(() => {
      openCanvas('thread-1', 'chart');
    });
    expect(await screen.findByRole('region', { name: 'Chart v1' })).toBeVisible();

    latest = 2;
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });

    const tab = await screen.findByRole('region', { name: 'Chart v2' });
    expect(within(tab).getByTestId('canvas-version-label')).toHaveTextContent('v2 / 2');
  });

  it('says so when the canvas is no longer in its thread', async () => {
    openCanvas('thread-1', 'gone');
    renderTabs(createHost({ readCanvases: async () => new Map() }));

    expect(await screen.findByText(/no longer in its thread/u)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Canvas' })).toBeVisible();
  });

  it('fails visibly when the thread cannot be read, never an empty canvas', async () => {
    openCanvas('thread-1', 'chart');
    openCanvas('thread-elsewhere', 'chart');
    renderTabs(
      createHost({
        readCanvases: async (threadId) => {
          if (threadId === 'thread-1') {
            throw new Error('host closed');
          }
          return;
        },
      })
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('canvas-error')).toHaveLength(2);
    });
    const errors = screen.getAllByTestId('canvas-error').map((error) => error.textContent);
    expect(errors).toContain('Canvas read failed: host closed');
    expect(errors).toContain('This thread is not owned by the agent host, so it has no canvases.');
  });

  it('shows a corrupt tab address as an error in its tab', async () => {
    useWorkspaceTabSelectionStore.getState().openApp('canvas-document:not-json');
    renderTabs(createHost({ readCanvases: async () => new Map() }));

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});

describe('canvas auto-open', () => {
  function hostWithCommits() {
    const listeners = new Set<(commit: AssistantThreadHostCanvasCommit) => void>();
    const host = createHost({
      readCanvases: async () =>
        new Map([
          ['chart', versions('chart', 'Chart', 1)],
          ['report', versions('report', 'Report', 1)],
        ]),
      subscribeCanvasCommits: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const commit = (threadId: string, canvasId: string) =>
      act(() => {
        for (const listener of listeners) {
          listener({ canvasId, threadId });
        }
      });
    /** The workspace is mounted and following the host's commits. */
    const following = () =>
      waitFor(() => {
        expect(listeners.size).toBe(1);
      });
    return { commit, following, host };
  }

  it('opens and selects a canvas the assistant writes on the thread on screen', async () => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });
    const { commit, following, host } = hostWithCommits();
    renderTabs(host, true);
    await following();

    commit('thread-1', 'chart');

    const id = canvasWorkspaceTabId({ canvasId: 'chart', threadId: 'thread-1' });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({ appId: id, kind: 'app' });
    expect(await screen.findByRole('region', { name: 'Chart' })).toBeVisible();
  });

  it('opens a subagent canvas while that subagent is open, but not one from a thread off screen', async () => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });
    useWorkspaceTabSelectionStore
      .getState()
      .openApp(hostChildWorkspaceTabId({ persona: 'explore', threadId: 'child-1' }));
    const { commit, following, host } = hostWithCommits();
    renderTabs(host, true);
    await following();

    commit('child-1', 'report');
    commit('thread-2', 'chart');

    const open = useWorkspaceTabSelectionStore.getState().openAppIds;
    expect(open).toContain(canvasWorkspaceTabId({ canvasId: 'report', threadId: 'child-1' }));
    expect(open).not.toContain(canvasWorkspaceTabId({ canvasId: 'chart', threadId: 'thread-2' }));
    expect(await screen.findByRole('region', { name: 'Report' })).toBeVisible();
  });

  it('keeps the current selection when a canvas that is already open gets a new version', async () => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-1' },
    });
    openCanvas('thread-1', 'chart');
    useWorkspaceTabSelectionStore.getState().selectApp('context-explorer');
    const { commit, following, host } = hostWithCommits();
    renderTabs(host, true);
    await following();

    commit('thread-1', 'chart');

    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });
});
