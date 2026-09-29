import './assistant-thread-tabs-workspace-test-support';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';
import {
  activeThreadId,
  dbMocks,
  finishRun,
  openThreadTabs,
  refreshThreadList,
  renderWorkspace,
  stageFinishedRun,
} from './assistant-thread-tabs-workspace-test-support';
import {
  blurWindow,
  blurWindowWithinAct,
  focusWindow,
  hideDocument,
  hideDocumentWithinAct,
  resetWindowActivity,
} from './window-activity-test-support';

/**
 * BST-1845: "seen" means the thread's transcript is on screen AND the window is
 * active — not merely that the thread is the active tab. The explorer surface
 * stays mounted under Settings and in a background window, so an active-thread
 * check stamped every run that finished while nobody was looking.
 */
const COMPLETED_AT = new Date('2026-04-22T11:00:20Z');
const ACTIVE_TITLE = 'Purchasing app search log';

function watermark(threadId: string): number | undefined {
  return useAssistantThreadStore.getState().lastViewedAtByThreadId[threadId];
}

function onScreenThreadId(): string | null {
  return useOnScreenThreadStore.getState().onScreenThreadId;
}

function setRoute(activeTab: 'explorer' | 'settings'): void {
  act(() => {
    usePanelLayoutStore.setState({ activeTab });
  });
}

/** Renders with the window in front and `thread-a` (the newest) on screen. */
async function renderOnScreen(): Promise<void> {
  focusWindow();
  renderWorkspace();
  await screen.findByRole('tab', { name: ACTIVE_TITLE });
  await waitFor(() => expect(onScreenThreadId()).toBe('thread-a'));
}

beforeEach(() => {
  usePanelLayoutStore.setState({ activeTab: 'explorer' });
});

afterEach(() => {
  resetWindowActivity();
  // The workspace is still mounted here (RTL unmounts after this hook).
  setRoute('explorer');
});

describe('AssistantThreadTabsWorkspace seen state', () => {
  it('does not badge a run that finishes on the active thread while it is on screen', async () => {
    await renderOnScreen();

    await finishRun('thread-a', COMPLETED_AT);

    // Stamped with the run's own completion time, not the renderer clock.
    await waitFor(() => expect(watermark('thread-a')).toBe(COMPLETED_AT.getTime()));
    expect(screen.getByRole('tab', { name: ACTIVE_TITLE })).toBeInTheDocument();
    expect(screen.queryByTestId('thread-unseen-glyph')).not.toBeInTheDocument();
  });

  // The window-level cases: the thread is still the ACTIVE tab, but nobody can
  // see it. Blurred is `visible` + unfocused (a covered window on Windows and
  // Linux); hidden is minimised or a background tab.
  it.each([
    ['the window is blurred', blurWindow],
    ['the document is hidden', hideDocument],
  ])(
    'badges the active thread when its run finishes while %s, and clears it on return',
    async (_case, leave) => {
      await renderOnScreen();
      leave();
      await waitFor(() => expect(onScreenThreadId()).toBeNull());

      await finishRun('thread-a', COMPLETED_AT);

      expect(
        await screen.findByRole('tab', { name: `${ACTIVE_TITLE}, finished` })
      ).toBeInTheDocument();
      expect(watermark('thread-a')).toBeUndefined();

      focusWindow();

      expect(await screen.findByRole('tab', { name: ACTIVE_TITLE })).toBeInTheDocument();
      expect(watermark('thread-a')).toBe(COMPLETED_AT.getTime());
    }
  );

  it('badges the active thread when its run finishes on another route, and clears it on return', async () => {
    await renderOnScreen();
    setRoute('settings');
    await waitFor(() => expect(onScreenThreadId()).toBeNull());

    await finishRun('thread-a', COMPLETED_AT, 'failed');

    expect(await screen.findByRole('tab', { name: `${ACTIVE_TITLE}, failed` })).toBeInTheDocument();
    expect(watermark('thread-a')).toBeUndefined();

    setRoute('explorer');

    expect(await screen.findByRole('tab', { name: ACTIVE_TITLE })).toBeInTheDocument();
    expect(watermark('thread-a')).toBe(COMPLETED_AT.getTime());
  });

  // Leaving a thread used to stamp it, marking a run seen that finished off
  // screen and was never shown. Here the switch is programmatic (a notification
  // click, a deep link) while Settings is up.
  it('does not mark a run seen because the user switches threads while it is off screen', async () => {
    await renderOnScreen();
    setRoute('settings');
    await finishRun('thread-a', COMPLETED_AT);
    await screen.findByRole('tab', { name: `${ACTIVE_TITLE}, finished` });

    openThreadTabs('thread-b');
    await waitFor(() => expect(activeThreadId()).toBe('thread-b'));

    expect(screen.getByRole('tab', { name: `${ACTIVE_TITLE}, finished` })).toBeInTheDocument();
    expect(watermark('thread-a')).toBeUndefined();
  });

  it('publishes nothing while the database gate replaces the transcript, even in a focused window', () => {
    focusWindow();
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-a' },
      openThreadIdsByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: ['thread-a'] },
    });
    dbMocks.database = null;
    dbMocks.providerError = new Error('PGlite startup failed.');

    renderWorkspace();

    expect(screen.getByText('Memory database failed')).toBeInTheDocument();
    expect(onScreenThreadId()).toBeNull();
  });

  // The loading card replaces the panels only with NO open tab (and then there
  // is no active thread to publish). With tabs already open the transcripts are
  // rendered while the list refreshes, so the active one IS on screen.
  it('publishes the active thread while the thread list is still loading with tabs open', () => {
    focusWindow();
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-a' },
      loadStateByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: { status: 'loading' } },
      openThreadIdsByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: ['thread-a'] },
    });

    renderWorkspace();

    expect(screen.getByTestId('assistant-thread-panel-thread-a')).toBeVisible();
    expect(screen.getByTestId('assistant-thread-wrapper')).toHaveTextContent('thread-a');
    expect(onScreenThreadId()).toBe('thread-a');
  });

  it('withdraws the claim when the thread list fails to load and the transcript is replaced', async () => {
    await renderOnScreen();

    act(() => {
      useAssistantThreadStore.setState({
        loadStateByResourceId: {
          [WORKSPACE_MEMORY_RESOURCE_ID]: {
            error: 'PGlite failed to initialize.',
            status: 'error',
          },
        },
      });
    });

    expect(screen.getByText('Assistant threads failed to load')).toBeInTheDocument();
    expect(onScreenThreadId()).toBeNull();
  });
});

/**
 * The store commits the refreshed thread list and, in the same synchronous tick
 * (inside that very `set`), `leave` runs — so React batches the two into ONE
 * render, as it does when a database event and a focus change are handled back
 * to back. A separate `act` per update, or an `await` between them, would let
 * React render the departure first and hide the race.
 */
async function refreshThreadListAnd(leave: () => void): Promise<void> {
  const unsubscribe = useAssistantThreadStore.subscribe((state, previous) => {
    if (state.threadsByResourceId !== previous.threadsByResourceId) {
      unsubscribe();
      leave();
    }
  });
  await act(refreshThreadList);
}

// The completion and the departure arrive in ONE render: a terminal-run refresh
// batched with a blur, a route change or a tab switch. The published claim is
// only written by a passive effect, so a reader that took it back from the store
// would still see the OUTGOING thread on screen and stamp the completion the user
// never saw. The publisher must feed its own consumers the identity it computed
// this render.
describe('AssistantThreadTabsWorkspace seen state, completion and departure in one render', () => {
  const realMarkThreadViewed = useAssistantThreadStore.getState().markThreadViewed;
  const markThreadViewed = vi.fn(realMarkThreadViewed);

  beforeEach(() => {
    markThreadViewed.mockClear();
    useAssistantThreadStore.setState({ markThreadViewed });
  });

  afterEach(() => {
    act(() => {
      useAssistantThreadStore.setState({ markThreadViewed: realMarkThreadViewed });
    });
  });

  it.each([
    ['the window blurs', () => blurWindowWithinAct(), () => focusWindow()],
    ['the document hides', () => hideDocumentWithinAct(), () => focusWindow()],
    [
      'the route leaves the explorer',
      () => usePanelLayoutStore.setState({ activeTab: 'settings' }),
      () => setRoute('explorer'),
    ],
    [
      'another tab becomes active',
      () =>
        useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b'),
      () => openThreadTabs('thread-a'),
    ],
  ])(
    'does not stamp a completion that lands in the same render as the departure: %s',
    async (_case, leave, comeBack) => {
      await renderOnScreen();
      markThreadViewed.mockClear();

      stageFinishedRun('thread-a', COMPLETED_AT);
      await refreshThreadListAnd(leave);

      expect(markThreadViewed).not.toHaveBeenCalled();
      expect(watermark('thread-a')).toBeUndefined();
      expect(
        await screen.findByRole('tab', { name: `${ACTIVE_TITLE}, finished` })
      ).toBeInTheDocument();

      comeBack();

      expect(await screen.findByRole('tab', { name: ACTIVE_TITLE })).toBeInTheDocument();
      expect(markThreadViewed).toHaveBeenCalledWith('thread-a', COMPLETED_AT.getTime());
    }
  );
});
