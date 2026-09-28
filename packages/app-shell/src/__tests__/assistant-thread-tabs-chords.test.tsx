import './assistant-thread-tabs-workspace-test-support';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { type ActionOutcome, NO_CLOSED_TAB_ERROR } from '@brainstrike/context-actions';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  getTabChordStrip,
  resolveTabChordScope,
  type TabChordStrip,
} from '../tab-chords/tab-chord-registry';
import {
  activeThreadId,
  addThreadRow,
  openThreadIds,
  openThreadTabs,
  renderWorkspace,
} from './assistant-thread-tabs-workspace-test-support';

const TITLES = {
  'thread-a': 'Purchasing app search log',
  'thread-b': 'Amazon Bedrock Converse',
  'thread-c': 'Release checklist',
} as const;

/** Three open thread tabs [a, b, c] with `a` active, registered with the chord router. */
async function renderThreeTabs(): Promise<TabChordStrip> {
  addThreadRow('thread-c', TITLES['thread-c']);
  renderWorkspace();
  await screen.findByRole('tab', { name: new RegExp(TITLES['thread-a']) });
  openThreadTabs('thread-b', 'thread-c', 'thread-a');
  const strip = getTabChordStrip('assistant-threads');
  if (!strip) {
    throw new Error('the assistant strip did not register with the chord router');
  }
  return strip;
}

async function reopen(strip: TabChordStrip): Promise<ActionOutcome | undefined> {
  let outcome: ActionOutcome | undefined;
  await act(async () => {
    outcome = await strip.reopenClosed();
  });
  return outcome;
}

function deleteThreadFromStore(threadId: string): void {
  act(() => {
    useAssistantThreadStore.setState((state) => ({
      threadsByResourceId: {
        ...state.threadsByResourceId,
        [WORKSPACE_MEMORY_RESOURCE_ID]: (
          state.threadsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID] ?? []
        ).filter((thread) => thread.id !== threadId),
      },
    }));
  });
}

describe('assistant thread strip — chords and closed-tab history', () => {
  it('registers its tabs, active tab and panel with the chord router', async () => {
    const strip = await renderThreeTabs();

    expect(strip.getTabs()).toEqual([
      { id: 'thread-a', label: TITLES['thread-a'] },
      { id: 'thread-b', label: TITLES['thread-b'] },
      { id: 'thread-c', label: TITLES['thread-c'] },
    ]);
    expect(strip.getActiveId()).toBe('thread-a');
    expect(resolveTabChordScope(screen.getByTestId('assistant-thread-panel-thread-a'))).toBe(
      'assistant-threads'
    );
    expect(resolveTabChordScope(document.body)).toBe('workspace');
  });

  it('reopens a ✕-closed tab at its old index and activates it', async () => {
    const strip = await renderThreeTabs();

    fireEvent.click(screen.getByTitle(`Close ${TITLES['thread-b']}`));
    expect(openThreadIds()).toEqual(['thread-a', 'thread-c']);

    expect(await reopen(strip)).toEqual({ ok: true });
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(activeThreadId()).toBe('thread-b');
  });

  it('records a Delete-key close', async () => {
    const strip = await renderThreeTabs();
    const tab = screen.getByRole('tab', { name: new RegExp(TITLES['thread-c']) });

    tab.focus();
    fireEvent.keyDown(tab, { key: 'Delete' });
    await waitFor(() => expect(openThreadIds()).toEqual(['thread-a', 'thread-b']));

    expect(await reopen(strip)).toEqual({ ok: true });
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
  });

  it('records a menu bulk close so consecutive reopens rebuild the old order', async () => {
    const strip = await renderThreeTabs();

    fireEvent.contextMenu(screen.getByRole('tab', { name: new RegExp(TITLES['thread-a']) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));
    expect(openThreadIds()).toEqual(['thread-a']);

    await reopen(strip);
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b']);
    await reopen(strip);
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(activeThreadId()).toBe('thread-c');
  });

  it('records Close to the Right and Close All', async () => {
    const strip = await renderThreeTabs();

    fireEvent.contextMenu(screen.getByRole('tab', { name: new RegExp(TITLES['thread-a']) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the Right' }));
    expect(openThreadIds()).toEqual(['thread-a']);
    fireEvent.contextMenu(screen.getByRole('tab', { name: new RegExp(TITLES['thread-a']) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    expect(openThreadIds()).toEqual([]);

    await reopen(strip);
    expect(openThreadIds()).toEqual(['thread-a']);
    await reopen(strip);
    await reopen(strip);
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
  });

  it('records a chord close', async () => {
    const strip = await renderThreeTabs();

    act(() => strip.close('thread-a'));
    expect(openThreadIds()).toEqual(['thread-b', 'thread-c']);

    await reopen(strip);
    expect(openThreadIds()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(activeThreadId()).toBe('thread-a');
  });

  it('skips a deleted thread and reports it, then reopens the next entry', async () => {
    const strip = await renderThreeTabs();
    act(() => strip.close('thread-a'));
    act(() => strip.close('thread-b'));
    deleteThreadFromStore('thread-b');

    expect(await reopen(strip)).toEqual({
      error: `"${TITLES['thread-b']}" was deleted and cannot be reopened`,
      ok: false,
    });
    expect(openThreadIds()).toEqual(['thread-c']);

    expect(await reopen(strip)).toEqual({ ok: true });
    expect(openThreadIds()).toEqual(['thread-a', 'thread-c']);
  });

  it('only activates a closed tab that was opened again in the meantime', async () => {
    const strip = await renderThreeTabs();
    act(() => strip.close('thread-a'));
    openThreadTabs('thread-a', 'thread-b');
    expect(openThreadIds()).toEqual(['thread-b', 'thread-c', 'thread-a']);

    expect(await reopen(strip)).toEqual({ ok: true });
    expect(openThreadIds()).toEqual(['thread-b', 'thread-c', 'thread-a']);
    expect(activeThreadId()).toBe('thread-a');
  });

  it('reports an empty history instead of doing nothing', async () => {
    const strip = await renderThreeTabs();

    expect(await reopen(strip)).toEqual({ error: NO_CLOSED_TAB_ERROR, ok: false });
  });
});
