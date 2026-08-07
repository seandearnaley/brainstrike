import { ThemeProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasPanel } from '../canvas/canvas-panel';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';

const queryMock = vi.fn();

vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: () => ({ query: queryMock }),
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
  });

  it('shows the no-thread empty state without querying', async () => {
    renderPanel();
    expect(await screen.findByText(/appear here/i)).toBeInTheDocument();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('shows the empty-thread state when the thread has no canvases', async () => {
    routeQueries([]);
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-1' });
    renderPanel();
    expect(await screen.findByText(/No canvases in this thread/i)).toBeInTheDocument();
  });

  it('renders the latest version through the sandboxed CanvasFrame with a version stepper', async () => {
    routeQueries();
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-1' });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-version-label')).toHaveTextContent('v3 / 3');
    });
    const frame = screen.getByTitle<HTMLIFrameElement>('Canvas');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.src.startsWith('https://shell.invalid/canvas-frame.html#nonce=')).toBe(true);
    // Latest ⇒ forward stepping disabled, backward enabled.
    expect(screen.getByTestId('canvas-version-next')).toBeDisabled();
    expect(screen.getByTestId('canvas-version-previous')).toBeEnabled();
  });

  it('steps back through history and clamps at version 1', async () => {
    routeQueries();
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-1' });
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

  it('re-queries when a manageCanvas completion bumps the refresh nonce', async () => {
    routeQueries();
    useChangesNavigationStore
      .getState()
      .setActiveThreadIdentity({ latestRunId: null, threadId: 'thread-1' });
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
});
