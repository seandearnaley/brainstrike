import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type AssistantMemoryThread,
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { ThemeProvider } from '@brainstrike/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactsPage } from '../artifacts/artifacts-page';
import {
  type AssistantThreadHostArtifact,
  type AssistantThreadHostArtifacts,
  type AssistantThreadHostCanvasCommit,
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { canvasWorkspaceTabId } from '../canvas/canvas-workspace-tab';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';

const toastMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastMock,
}));

const SHELL = 'https://shell.invalid/canvas-frame.html';

function artifact(
  canvasId: string,
  title: string,
  threadId: string,
  rootThreadId = threadId
): AssistantThreadHostArtifact {
  return {
    canvasId,
    createdBy: 'assistant',
    rootThreadId,
    threadId,
    title,
    updatedAt: '2026-10-27T10:00:00.000Z',
    version: 2,
  };
}

const LISTED = [
  artifact('chart', 'Revenue chart', 'thread-sales'),
  artifact('itinerary', 'Lisbon itinerary', 'child-1', 'thread-trip'),
];

function thread(id: string, title: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-10-27T09:00:00.000Z'),
    id,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title,
    updatedAt: new Date('2026-10-27T10:00:00.000Z'),
  };
}

const refused = (): Promise<never> => Promise.reject(new Error('not used by the gallery'));

function createHost(
  overrides: Partial<AssistantThreadHostCapability> = {}
): AssistantThreadHostCapability {
  return {
    createThread: refused,
    deleteThread: refused,
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderThread: () => null,
    updateThreadBinding: refused,
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
    ...overrides,
  };
}

function artifacts(list: AssistantThreadHostArtifacts['list']): AssistantThreadHostArtifacts {
  return {
    list,
    read: async (threadId, canvasId) => ({
      canvasId,
      createdAt: '2026-10-27T10:00:00.000Z',
      createdBy: 'assistant',
      html: `<h1>${canvasId} in ${threadId}</h1>`,
      title: canvasId === 'chart' ? 'Revenue chart' : 'Lisbon itinerary',
      version: 2,
    }),
  };
}

const themeStorageAdapter = {
  getItem: () => Promise.resolve('light'),
  removeItem: () => Promise.resolve(),
  setItem: () => Promise.resolve(),
};

function renderPage(host: AssistantThreadHostCapability) {
  return render(
    <ThemeProvider storageAdapter={themeStorageAdapter}>
      <AssistantThreadHostContext.Provider value={host}>
        <ArtifactsPage shellSrc={SHELL} />
      </AssistantThreadHostContext.Provider>
    </ThemeProvider>
  );
}

function cardTitles(): string[] {
  return within(screen.getByRole('list', { name: 'Artifacts' }))
    .getAllByTestId('artifact-card')
    .map((card) => card.querySelector('span span')?.textContent ?? '');
}

beforeEach(() => {
  resetAssistantThreadStore();
  useAssistantThreadStore.setState({
    threadsByResourceId: {
      [WORKSPACE_MEMORY_RESOURCE_ID]: [
        thread('thread-sales', 'Sales review'),
        thread('thread-trip', 'Trip planning'),
      ],
    },
  });
  usePanelLayoutStore.getState().setActiveTab('artifacts');
});

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  vi.restoreAllMocks();
  usePanelLayoutStore.getState().setActiveTab('explorer');
});

describe('ArtifactsPage', () => {
  it("lists every thread's canvases with the thread each one lives in", async () => {
    renderPage(createHost({ artifacts: artifacts(async () => LISTED) }));

    await screen.findByRole('list', { name: 'Artifacts' });
    expect(cardTitles()).toEqual(['Revenue chart', 'Lisbon itinerary']);
    expect(screen.getByText('2 canvases from your threads')).toBeVisible();
    expect(screen.getByText('Sales review')).toBeVisible();
    // A subagent's canvas is labelled with the top-level thread it ran under.
    expect(screen.getByText('Trip planning · subagent')).toBeVisible();
  });

  it('searches by artifact title and by thread name', async () => {
    renderPage(createHost({ artifacts: artifacts(async () => LISTED) }));
    const search = await screen.findByRole('searchbox', { name: 'Search artifacts' });

    fireEvent.change(search, { target: { value: 'revenue' } });
    expect(cardTitles()).toEqual(['Revenue chart']);

    fireEvent.change(search, { target: { value: 'trip' } });
    expect(cardTitles()).toEqual(['Lisbon itinerary']);

    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText('No artifacts match “nothing like this”.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(cardTitles()).toEqual(['Revenue chart', 'Lisbon itinerary']);
  });

  it('opens an artifact in its own tab on the thread it lives in', async () => {
    const open = vi.spyOn(threadWorkspaceNavigation, 'open').mockImplementation(() => undefined);
    renderPage(createHost({ artifacts: artifacts(async () => LISTED) }));
    await screen.findByRole('list', { name: 'Artifacts' });

    fireEvent.click(screen.getByRole('button', { name: /^Lisbon itinerary/ }));

    expect(open).toHaveBeenCalledWith(
      WORKSPACE_MEMORY_RESOURCE_ID,
      'thread-trip',
      canvasWorkspaceTabId({ canvasId: 'itinerary', threadId: 'child-1' })
    );
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('downloads the latest version as a standalone HTML file', async () => {
    const saveToDownloads = vi.fn(async (_file: { bytes: Uint8Array; filename: string }) => ({
      ok: true as const,
      path: '/downloads/revenue-chart.html',
    }));
    vi.stubGlobal('fileExports', { saveToDownloads });
    try {
      renderPage(createHost({ artifacts: artifacts(async () => LISTED) }));
      await screen.findByRole('list', { name: 'Artifacts' });

      fireEvent.click(screen.getByRole('button', { name: 'Download Revenue chart as HTML' }));

      await waitFor(() => {
        expect(toastMock).toHaveBeenCalledWith({
          description: '/downloads/revenue-chart.html',
          title: 'Artifact saved',
        });
      });
      const [file] = saveToDownloads.mock.calls[0] ?? [];
      expect(file?.filename).toMatch(/^Revenue-chart.*v2\.html$/);
      expect(new TextDecoder().decode(file?.bytes)).toBe(
        '<!doctype html>\n<meta charset="utf-8">\n<h1>chart in thread-sales</h1>'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows a failed list as an error, never an empty gallery', async () => {
    renderPage(
      createHost({
        artifacts: artifacts(async () => {
          throw new Error('host closed');
        }),
      })
    );

    expect(await screen.findByTestId('artifacts-error')).toHaveTextContent(
      'Artifacts could not be listed: host closed'
    );
    expect(screen.queryByText('No artifacts yet')).not.toBeInTheDocument();
  });

  it('says when there are no artifacts yet', async () => {
    renderPage(createHost({ artifacts: artifacts(async () => []) }));

    expect(await screen.findByText('No artifacts yet')).toBeVisible();
  });

  it('lists again when a run commits a canvas while the page is open', async () => {
    const listeners = new Set<(commit: AssistantThreadHostCanvasCommit) => void>();
    let listed = [LISTED[0] as AssistantThreadHostArtifact];
    renderPage(
      createHost({
        artifacts: artifacts(async () => listed),
        subscribeCanvasCommits: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      })
    );
    await screen.findByRole('list', { name: 'Artifacts' });
    expect(cardTitles()).toEqual(['Revenue chart']);

    listed = [...LISTED];
    act(() => {
      for (const listener of listeners) {
        listener({ canvasId: 'itinerary', threadId: 'child-1' });
      }
    });

    await waitFor(() => {
      expect(cardTitles()).toEqual(['Revenue chart', 'Lisbon itinerary']);
    });
  });

  it('previews a card whose read was abandoned when it scrolled away and back', async () => {
    const onScreen = new Set<(near: boolean) => void>();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) {
          onScreen.add((near) => callback([{ isIntersecting: near }]));
        }
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(): void {
          this.callback();
        }
        disconnect(): void {}
      }
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(256);
    type Read = Awaited<ReturnType<AssistantThreadHostArtifacts['read']>>;
    const pending: ((canvas: Read) => void)[] = [];
    const read = vi.fn(() => new Promise<Read>((resolve) => pending.push(resolve)));
    const scroll = (near: boolean): void =>
      act(() => {
        for (const report of onScreen) {
          report(near);
        }
      });
    try {
      renderPage(createHost({ artifacts: { list: async () => LISTED.slice(0, 1), read } }));
      await screen.findByRole('list', { name: 'Artifacts' });

      scroll(true);
      scroll(false);
      scroll(true);
      expect(read).toHaveBeenCalledTimes(2);
      const canvas = await artifacts(async () => []).read('thread-sales', 'chart');
      await act(async () => {
        for (const resolve of pending) {
          resolve(canvas);
        }
      });

      expect(screen.getByTitle('Canvas')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is unavailable until the agent host is connected', async () => {
    renderPage(createHost());

    expect(
      await screen.findByText('Artifacts are unavailable until the agent host is connected.')
    ).toBeVisible();
  });
});
