import {
  resetAssistantThreadStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { ThemeProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasPanel } from '../canvas/canvas-panel';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';

const queryMock = vi.fn();

// IDENTITY-STABLE handle, like the real usePGliteDatabase (a context value):
// a fresh object per render would re-run every database-keyed effect on every
// render and spin the panel's clear-then-refetch cycle into an OOM loop.
const stableDatabaseHandle = { query: queryMock };

vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: () => stableDatabaseHandle,
}));

const SUMMARIES = [
  { canvasId: 'canvas-1', createdAt: '2026-08-07 01:00:00+00', latestVersion: 3, title: 'Chart' },
];

function versionRow(version: number) {
  return {
    createdAt: '2026-08-07 01:00:00+00',
    createdBy: 'assistant',
    html: `<p>v${version}</p>`,
    version,
  };
}

function routeQueries(summaries: readonly unknown[] = SUMMARIES): void {
  queryMock.mockImplementation((sql: string, params?: readonly unknown[]) => {
    if (/DISTINCT ON/i.test(sql)) {
      return Promise.resolve({ rows: [...summaries] });
    }
    return Promise.resolve({ rows: [versionRow(Number(params?.[1]))] });
  });
}

// The real ThemeProvider renders null until its async storage load resolves,
// so it gets an immediately-resolving adapter and every assertion below
// awaits (findBy*/waitFor).
const themeStorageAdapter = {
  getItem: () => Promise.resolve('light'),
  removeItem: () => Promise.resolve(),
  setItem: () => Promise.resolve(),
};

function renderPanel(): ReturnType<typeof render> {
  return render(
    <ThemeProvider storageAdapter={themeStorageAdapter}>
      <CanvasPanel shellSrc="https://shell.invalid/canvas-frame.html" />
    </ThemeProvider>
  );
}

describe('CanvasPanel', () => {
  beforeEach(() => {
    queryMock.mockReset();
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

  it('shows the no-thread empty state without querying', async () => {
    renderPanel();
    expect(await screen.findByText(/appear here/i)).toBeInTheDocument();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('shows the empty-thread state when the thread has no canvases', async () => {
    routeQueries([]);
    activateThread('thread-1');
    renderPanel();
    expect(await screen.findByText(/No canvases in this thread/i)).toBeInTheDocument();
  });

  it('renders the latest version through the sandboxed CanvasFrame with a version stepper', async () => {
    routeQueries();
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

  const TWO_SUMMARIES = [
    { canvasId: 'canvas-1', createdAt: '2026-08-07 01:00:00+00', latestVersion: 3, title: 'Chart' },
    {
      canvasId: 'canvas-2',
      createdAt: '2026-08-07 02:00:00+00',
      latestVersion: 5,
      title: 'Report',
    },
  ];

  it('shows the canvas the navigation store focused (a canvas:// chip click), not the newest', async () => {
    routeQueries(TWO_SUMMARIES);
    activateThread('thread-1');
    useChangesNavigationStore.getState().openCanvas('canvas-2');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v5 / 5');
    });
    expect(screen.getByTestId('canvas-picker')).toHaveValue('canvas-2');
  });

  it('the picker writes the store, so a chip click and the picker share one selection', async () => {
    routeQueries(TWO_SUMMARIES);
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
    routeQueries(TWO_SUMMARIES);
    activateThread('thread-1');
    useChangesNavigationStore.getState().selectCanvas('canvas-from-another-thread');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-picker')).toHaveValue('canvas-1');
    });
  });

  it('steps back through history and clamps at version 1', async () => {
    routeQueries();
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
    queryMock.mockRejectedValue(new Error('relation gone'));
    activateThread('thread-1');
    renderPanel();

    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(/Canvas list failed/);
    expect(screen.queryByText(/No canvases in this thread/i)).not.toBeInTheDocument();
  });

  it('surfaces a failed version read under the header instead of silently keeping stale content', async () => {
    let failVersionReads = false;
    queryMock.mockImplementation((sql: string, params?: readonly unknown[]) => {
      if (/DISTINCT ON/i.test(sql)) {
        return Promise.resolve({ rows: [...SUMMARIES] });
      }
      if (failVersionReads) {
        return Promise.reject(new Error('db closed'));
      }
      return Promise.resolve({ rows: [versionRow(Number(params?.[1]))] });
    });
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    });

    failVersionReads = true;
    fireEvent.click(screen.getByTestId('canvas-version-previous'));

    expect(await screen.findByTestId('canvas-error')).toHaveTextContent(/Canvas read failed/);
    // The stale v3 document was cleared, not left rendering under the v2 label.
    expect(screen.queryByTitle('Canvas')).not.toBeInTheDocument();
  });

  it('re-queries when a manageCanvas completion bumps the refresh nonce', async () => {
    routeQueries();
    activateThread('thread-1');
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toBeInTheDocument();
    });
    const callsBefore = queryMock.mock.calls.length;

    useChangesNavigationStore.getState().requestCanvasRefresh();

    await waitFor(() => {
      expect(queryMock.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('ignores a background wrapper identity — only the thread store active id selects canvases', async () => {
    routeQueries([]);
    activateThread('thread-1');
    // A background thread's wrapper publishes its identity (the old
    // last-mount-wins bug) — the panel must keep querying thread-1.
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-background' });
    renderPanel();
    await screen.findByText(/No canvases in this thread/i);
    const queried = queryMock.mock.calls.map((call) => call[1]?.[0]);
    expect(queried).toContain('thread-1');
    expect(queried).not.toContain('thread-background');
  });
});
