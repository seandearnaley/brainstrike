import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { ThemeProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCanvasVersion,
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { CanvasPanel } from '../canvas/canvas-panel';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';

type CanvasMap = ReadonlyMap<string, readonly AssistantThreadHostCanvasVersion[]>;

const readCanvases = vi.fn<(threadId: string) => Promise<CanvasMap | undefined>>();

function version(
  canvasId: string,
  number: number,
  createdAt = '2026-08-07T01:00:00.000Z'
): AssistantThreadHostCanvasVersion {
  return {
    canvasId,
    createdAt,
    createdBy: 'assistant',
    html: `<p>${canvasId} v${number}</p>`,
    title: canvasId === 'canvas-1' ? 'Chart' : 'Report',
    version: number,
  };
}

function versions(
  canvasId: string,
  latest: number,
  createdAt?: string
): AssistantThreadHostCanvasVersion[] {
  return Array.from({ length: latest }, (_, index) => version(canvasId, index + 1, createdAt));
}

const ONE_CANVAS: CanvasMap = new Map([['canvas-1', versions('canvas-1', 3)]]);

/** canvas-1 is the newest canvas; canvas-2 has more versions. */
const TWO_CANVASES: CanvasMap = new Map([
  ['canvas-1', versions('canvas-1', 3, '2026-08-07T02:00:00.000Z')],
  ['canvas-2', versions('canvas-2', 5, '2026-08-07T01:00:00.000Z')],
]);

/** The host owns every thread and answers with `canvases`. */
function ownCanvases(canvases: CanvasMap): void {
  readCanvases.mockImplementation(async () => canvases);
}

function createHost(
  overrides: Partial<AssistantThreadHostCapability> = {}
): AssistantThreadHostCapability {
  return {
    createThread: vi.fn(),
    deleteThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => []),
    ownsThread: vi.fn(async () => true),
    readCanvases,
    renameThread: vi.fn(),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
    ...overrides,
  };
}

// The real ThemeProvider renders null until its async storage load resolves,
// so it gets an immediately-resolving adapter and every assertion below
// awaits (findBy*/waitFor).
const themeStorageAdapter = {
  getItem: () => Promise.resolve('light'),
  removeItem: () => Promise.resolve(),
  setItem: () => Promise.resolve(),
};

function renderPanel(
  host: AssistantThreadHostCapability = createHost()
): ReturnType<typeof render> {
  return render(
    <ThemeProvider storageAdapter={themeStorageAdapter}>
      <AssistantThreadHostContext.Provider value={host}>
        <CanvasPanel shellSrc="https://shell.invalid/canvas-frame.html" />
      </AssistantThreadHostContext.Provider>
    </ThemeProvider>
  );
}

describe('CanvasPanel', () => {
  beforeEach(() => {
    readCanvases.mockReset();
    useChangesNavigationStore.getState().reset();
    resetAssistantThreadStore();
  });

  function activateThread(threadId: string): void {
    // BST-1268 unification: CanvasPanel keys off the thread store's active
    // thread — never the wrapper-published identity.
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: threadId },
    });
  }

  it('shows the no-thread empty state without reading', async () => {
    renderPanel();
    expect(await screen.findByText(/appear here/i)).toBeInTheDocument();
    expect(readCanvases).not.toHaveBeenCalled();
  });

  it('shows the empty-thread state when the thread has no canvases', async () => {
    ownCanvases(new Map());
    activateThread('thread-1');
    renderPanel();
    expect(await screen.findByText(/No canvases in this thread/i)).toBeInTheDocument();
  });

  it('fails visibly for a thread the host does not own, never the empty state', async () => {
    readCanvases.mockResolvedValue(undefined);
    activateThread('thread-elsewhere');
    renderPanel();

    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(
      /not owned by the agent host/
    );
    expect(screen.queryByText(/No canvases in this thread/i)).not.toBeInTheDocument();
  });

  it('renders the latest version through the sandboxed CanvasFrame with a version stepper', async () => {
    ownCanvases(ONE_CANVAS);
    activateThread('thread-1');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    });
    const frame = await screen.findByTitle<HTMLIFrameElement>('Canvas');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.src.startsWith('https://shell.invalid/canvas-frame.html#nonce=')).toBe(true);
    // Latest ⇒ forward stepping disabled, backward enabled.
    expect(screen.getByTestId('canvas-version-next')).toBeDisabled();
    expect(screen.getByTestId('canvas-version-previous')).toBeEnabled();
  });

  it('shows the canvas the navigation store focused (a canvas:// chip click), not the newest', async () => {
    ownCanvases(TWO_CANVASES);
    activateThread('thread-1');
    useChangesNavigationStore.getState().openCanvas('canvas-2');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v5 / 5');
    });
    expect(screen.getByTestId('canvas-picker')).toHaveValue('canvas-2');
  });

  it('the picker writes the store, so a chip click and the picker share one selection', async () => {
    ownCanvases(TWO_CANVASES);
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-picker')).toHaveValue('canvas-1');
    });

    fireEvent.change(screen.getByTestId('canvas-picker'), { target: { value: 'canvas-2' } });

    expect(useChangesNavigationStore.getState().focusedCanvasId).toBe('canvas-2');
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v5 / 5');
    });
  });

  it('a focused id that is not in this thread falls back to the newest canvas', async () => {
    ownCanvases(TWO_CANVASES);
    activateThread('thread-1');
    useChangesNavigationStore.getState().selectCanvas('canvas-from-another-thread');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-picker')).toHaveValue('canvas-1');
    });
  });

  it('steps back through history and clamps at version 1', async () => {
    ownCanvases(ONE_CANVAS);
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    });

    fireEvent.click(screen.getByTestId('canvas-version-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v2 / 3');
    });
    fireEvent.click(screen.getByTestId('canvas-version-previous'));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v1 / 3');
    });
    expect(screen.getByTestId('canvas-version-previous')).toBeDisabled();
  });

  it('surfaces a failed summaries read as a visible error, never the empty-state lie', async () => {
    readCanvases.mockRejectedValue(new Error('host gone'));
    activateThread('thread-1');
    renderPanel();

    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(/Canvas list failed/);
    expect(screen.queryByText(/No canvases in this thread/i)).not.toBeInTheDocument();
  });

  it('surfaces a failed version read under the header instead of silently keeping stale content', async () => {
    ownCanvases(ONE_CANVAS);
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    });

    readCanvases.mockRejectedValue(new Error('host closed'));
    fireEvent.click(screen.getByTestId('canvas-version-previous'));

    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(/Canvas read failed/);
    // The stale v3 document was cleared, not left rendering under the v2 label.
    expect(screen.queryByTitle('Canvas')).not.toBeInTheDocument();
  });

  it('re-reads when a manageCanvas completion bumps the refresh nonce', async () => {
    ownCanvases(ONE_CANVAS);
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toBeInTheDocument();
    });
    const callsBefore = readCanvases.mock.calls.length;

    act(() => {
      useChangesNavigationStore.getState().requestCanvasRefresh();
    });

    await waitFor(() => {
      expect(readCanvases.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("re-reads a host thread's canvases when its committed canvases change", async () => {
    const committed = [version('canvas-1', 1)];
    readCanvases.mockImplementation(async () => new Map([['canvas-1', [...committed]]]));
    const listeners = new Set<() => void>();
    const subscribeCanvases = vi.fn((_threadId: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    activateThread('host-thread');
    const view = renderPanel(createHost({ subscribeCanvases }));
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v1 / 1');
    });
    expect(subscribeCanvases).toHaveBeenCalledWith('host-thread', expect.any(Function));

    // A run commits a new version while the panel is open.
    committed.push(version('canvas-1', 2));
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v2 / 2');
    });
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it('ignores a background wrapper identity — only the thread store active id selects canvases', async () => {
    ownCanvases(new Map());
    activateThread('thread-1');
    // A background thread's wrapper publishes its identity (the old
    // last-mount-wins bug) — the panel must keep reading thread-1.
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-background' });
    renderPanel();
    // The read starts in an effect after the panel first renders, and the empty
    // state shows while it is in flight: wait for the host read itself, not the
    // empty state, before asserting which thread it read (BST-1991).
    const readThreads = () => readCanvases.mock.calls.map(([threadId]) => threadId);
    await waitFor(() => {
      expect(readThreads()).toContain('thread-1');
    });
    await screen.findByText(/No canvases in this thread/i);
    expect(readThreads()).not.toContain('thread-background');
  });
});
