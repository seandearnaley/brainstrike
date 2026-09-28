import { type ActionOutcome, NO_CLOSED_TAB_OUTCOME } from '@brainstrike/context-actions';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import {
  getTabChordStrip,
  registerTabChordStrip,
  type TabChordStrip,
  type TabChordStripId,
} from '../tab-chord-registry';
import { useTabChords } from '../use-tab-chords';

interface FakeStrip extends TabChordStrip {
  readonly activate: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  readonly close: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  readonly reopenClosed: ReturnType<typeof vi.fn<() => Promise<ActionOutcome>>>;
}

function fakeStrip(
  ids: readonly string[],
  activeId: string | null,
  panel: HTMLElement | null
): FakeStrip {
  return {
    activate: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    close: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    getActiveId: () => activeId,
    getPanel: () => panel,
    getTabs: () => ids.map((id) => ({ id, label: id.toUpperCase() })),
    hasClosedTabs: () => true,
    reopenClosed: vi.fn<() => Promise<ActionOutcome>>(() => Promise.resolve({ ok: true })),
  };
}

function Router({
  claimWindowChords,
  isMac,
}: {
  readonly claimWindowChords: boolean;
  readonly isMac: boolean;
}): ReactElement | null {
  useTabChords({ claimWindowChords, isMac });
  return null;
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const CTRL_PAGE_DOWN: KeyboardEventInit = { ctrlKey: true, key: 'PageDown' };

describe('useTabChords', () => {
  let assistantPanel: HTMLElement;
  let assistantInput: HTMLTextAreaElement;
  let browserPanel: HTMLElement;
  let browserInput: HTMLInputElement;
  let outside: HTMLButtonElement;
  let strips: Record<TabChordStripId, FakeStrip>;
  let unregister: (() => void)[];

  function mount(options: { claimWindowChords: boolean; isMac: boolean }): void {
    render(<Router {...options} />);
  }

  beforeEach(() => {
    toastSpy.mockClear();
    assistantPanel = document.createElement('div');
    assistantInput = document.createElement('textarea');
    assistantPanel.append(assistantInput);
    browserPanel = document.createElement('div');
    browserInput = document.createElement('input');
    browserPanel.append(browserInput);
    outside = document.createElement('button');
    document.body.append(assistantPanel, browserPanel, outside);
    strips = {
      'assistant-threads': fakeStrip(['t1', 't2', 't3'], 't1', assistantPanel),
      browser: fakeStrip(['b1', 'b2'], 'b2', browserPanel),
      workspace: fakeStrip(['files', 'a.ts', 'b.ts'], 'b.ts', null),
    };
    unregister = (Object.keys(strips) as TabChordStripId[]).map((id) =>
      registerTabChordStrip(id, strips[id])
    );
  });

  afterEach(() => {
    for (const release of unregister) {
      release();
    }
    assistantPanel.remove();
    browserPanel.remove();
    outside.remove();
  });

  describe('focus scope', () => {
    it('acts on the assistant strip when focus is inside the assistant panel', () => {
      mount({ claimWindowChords: false, isMac: false });
      assistantInput.focus();

      const event = press(assistantInput, CTRL_PAGE_DOWN);

      expect(event.defaultPrevented).toBe(true);
      expect(strips['assistant-threads'].activate).toHaveBeenCalledWith('t2');
      expect(strips.workspace.activate).not.toHaveBeenCalled();
      expect(strips.browser.activate).not.toHaveBeenCalled();
    });

    it('acts on the browser strip when focus is inside the browser pane', () => {
      mount({ claimWindowChords: false, isMac: false });
      browserInput.focus();

      press(browserInput, CTRL_PAGE_DOWN);

      expect(strips.browser.activate).toHaveBeenCalledWith('b1');
      expect(strips.workspace.activate).not.toHaveBeenCalled();
      expect(strips['assistant-threads'].activate).not.toHaveBeenCalled();
    });

    it('acts on the workspace strip when focus is in no panel', () => {
      mount({ claimWindowChords: false, isMac: false });
      outside.focus();

      press(outside, { ctrlKey: true, key: 'PageUp' });

      expect(strips.workspace.activate).toHaveBeenCalledWith('a.ts');
      expect(strips.browser.activate).not.toHaveBeenCalled();
      expect(strips['assistant-threads'].activate).not.toHaveBeenCalled();
    });

    it('acts on the workspace strip when nothing has focus', () => {
      mount({ claimWindowChords: false, isMac: false });
      (document.activeElement as HTMLElement | null)?.blur();

      press(document.body, CTRL_PAGE_DOWN);

      expect(strips.workspace.activate).toHaveBeenCalledWith('files');
    });
  });

  describe('web (the browser owns ⌘W, ⌘T and Ctrl+Tab)', () => {
    const reserved: readonly [string, KeyboardEventInit][] = [
      ['⌘W', { key: 'w', metaKey: true }],
      ['⌘T', { key: 't', metaKey: true }],
      ['⌘⇧T', { key: 'T', metaKey: true, shiftKey: true }],
      ['Ctrl+Tab', { ctrlKey: true, key: 'Tab' }],
      ['Ctrl+Shift+Tab', { ctrlKey: true, key: 'Tab', shiftKey: true }],
    ];

    it.each(reserved)('leaves %s untouched', (_label, init) => {
      mount({ claimWindowChords: false, isMac: true });
      outside.focus();

      const event = press(outside, init);

      expect(event.defaultPrevented).toBe(false);
      expect(strips.workspace.close).not.toHaveBeenCalled();
      expect(strips.workspace.activate).not.toHaveBeenCalled();
      expect(strips.workspace.reopenClosed).not.toHaveBeenCalled();
    });

    it('still cycles with ⌘⌥→ on macOS', () => {
      mount({ claimWindowChords: false, isMac: true });
      outside.focus();

      const event = press(outside, { altKey: true, key: 'ArrowRight', metaKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(strips.workspace.activate).toHaveBeenCalledWith('files');
    });
  });

  describe('desktop', () => {
    it('⌘W closes the active tab of the focus-scoped strip', () => {
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      const event = press(assistantInput, { key: 'w', metaKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(strips['assistant-threads'].close).toHaveBeenCalledWith('t1');
      expect(strips.workspace.close).not.toHaveBeenCalled();
    });

    it('keeps focus in the strip when the close removed the focused element', async () => {
      const tablist = document.createElement('div');
      tablist.setAttribute('role', 'tablist');
      tablist.tabIndex = -1;
      const nextTab = document.createElement('button');
      nextTab.setAttribute('role', 'tab');
      nextTab.setAttribute('aria-selected', 'false');
      tablist.append(nextTab);
      assistantPanel.prepend(tablist);
      strips['assistant-threads'].close.mockImplementation(() => {
        // The closed thread's panel unmounts with the composer in it.
        assistantInput.remove();
        nextTab.setAttribute('aria-selected', 'true');
        return Promise.resolve();
      });
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { key: 'w', metaKey: true });

      await vi.waitFor(() => expect(document.activeElement).toBe(nextTab));
    });

    it('falls back to the tablist when the close emptied the strip', async () => {
      const tablist = document.createElement('div');
      tablist.setAttribute('role', 'tablist');
      tablist.tabIndex = -1;
      assistantPanel.prepend(tablist);
      strips['assistant-threads'].close.mockImplementation(() => {
        assistantInput.remove();
        return Promise.resolve();
      });
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { key: 'w', metaKey: true });

      await vi.waitFor(() => expect(document.activeElement).toBe(tablist));
    });

    it('keeps focus in the strip when cycling hid the focused panel', async () => {
      const nextTab = document.createElement('button');
      nextTab.setAttribute('role', 'tab');
      nextTab.setAttribute('aria-selected', 'false');
      assistantPanel.prepend(nextTab);
      strips['assistant-threads'].activate.mockImplementation(() => {
        // The previous thread's panel is hidden with the composer in it. The
        // browser moves focus off a hidden element only at its next rendering
        // step, AFTER animation frames run, so focus is still on it here.
        assistantInput.hidden = true;
        nextTab.setAttribute('aria-selected', 'true');
        return Promise.resolve();
      });
      mount({ claimWindowChords: false, isMac: false });
      assistantInput.focus();

      press(assistantInput, CTRL_PAGE_DOWN);

      await vi.waitFor(() => expect(document.activeElement).toBe(nextTab));
    });

    it('keeps focus in the strip when a reopen hid the focused panel', async () => {
      const reopenedTab = document.createElement('button');
      reopenedTab.setAttribute('role', 'tab');
      reopenedTab.setAttribute('aria-selected', 'false');
      assistantPanel.prepend(reopenedTab);
      strips['assistant-threads'].reopenClosed.mockImplementation(() => {
        assistantInput.hidden = true;
        reopenedTab.setAttribute('aria-selected', 'true');
        return Promise.resolve({ ok: true });
      });
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { key: 'T', metaKey: true, shiftKey: true });

      await vi.waitFor(() => expect(document.activeElement).toBe(reopenedTab));
    });

    it('restores focus only once an asynchronous close has settled', async () => {
      const tablist = document.createElement('div');
      tablist.setAttribute('role', 'tablist');
      const nextTab = document.createElement('button');
      nextTab.setAttribute('role', 'tab');
      nextTab.setAttribute('aria-selected', 'false');
      tablist.append(nextTab);
      browserPanel.prepend(tablist);
      let finishClose: () => void = () => undefined;
      strips.browser.close.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishClose = () => {
              // Main closed the tab: the strip re-renders without the focused tab.
              browserInput.remove();
              nextTab.setAttribute('aria-selected', 'true');
              resolve();
            };
          })
      );
      mount({ claimWindowChords: true, isMac: true });
      browserInput.focus();

      press(browserInput, { key: 'w', metaKey: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(browserInput);
      finishClose();

      await vi.waitFor(() => expect(document.activeElement).toBe(nextTab));
    });

    it('restores focus into a strip that scopes by fallback through its focus root', async () => {
      const workspaceRoot = document.createElement('div');
      const tablist = document.createElement('div');
      tablist.setAttribute('role', 'tablist');
      const focusedTab = document.createElement('button');
      focusedTab.setAttribute('role', 'tab');
      const nextTab = document.createElement('button');
      nextTab.setAttribute('role', 'tab');
      nextTab.setAttribute('aria-selected', 'false');
      tablist.append(focusedTab, nextTab);
      workspaceRoot.append(tablist);
      document.body.append(workspaceRoot);
      unregister.push(
        replaceStrip('workspace', {
          ...strips.workspace,
          close: () => {
            focusedTab.remove();
            nextTab.setAttribute('aria-selected', 'true');
            return Promise.resolve();
          },
          getFocusRoot: () => workspaceRoot,
        })
      );
      mount({ claimWindowChords: true, isMac: true });
      focusedTab.focus();

      try {
        press(focusedTab, { key: 'w', metaKey: true });

        await vi.waitFor(() => expect(document.activeElement).toBe(nextTab));
      } finally {
        workspaceRoot.remove();
      }
    });

    it('leaves surviving focus where it was after a close', async () => {
      const selectedTab = document.createElement('button');
      selectedTab.setAttribute('role', 'tab');
      selectedTab.setAttribute('aria-selected', 'true');
      assistantPanel.prepend(selectedTab);
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { key: 'w', metaKey: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));

      expect(document.activeElement).toBe(assistantInput);
    });

    it('matches ⌘W by physical key on a non-Latin layout (Russian ц on KeyW)', () => {
      mount({ claimWindowChords: true, isMac: true });
      outside.focus();

      const event = press(outside, { code: 'KeyW', key: 'ц', metaKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(strips.workspace.close).toHaveBeenCalledWith('b.ts');
    });

    it('matches ⌘⇧T by physical key on a non-Latin layout (Russian Е on KeyT)', () => {
      mount({ claimWindowChords: true, isMac: true });
      outside.focus();

      press(outside, { code: 'KeyT', key: 'Е', metaKey: true, shiftKey: true });

      expect(strips.workspace.reopenClosed).toHaveBeenCalledOnce();
    });

    it('never matches by physical key on a Latin layout (Dvorak "," on KeyW is ⌘,)', () => {
      mount({ claimWindowChords: true, isMac: true });
      outside.focus();

      const comma = press(outside, { code: 'KeyW', key: ',', metaKey: true });
      const dvorakW = press(outside, { code: 'Comma', key: 'w', metaKey: true });

      expect(comma.defaultPrevented).toBe(false);
      expect(dvorakW.defaultPrevented).toBe(true);
      expect(strips.workspace.close).toHaveBeenCalledOnce();
    });

    it('Ctrl+W closes on Windows and Linux', () => {
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      press(outside, { ctrlKey: true, key: 'w' });

      expect(strips.workspace.close).toHaveBeenCalledWith('b.ts');
    });

    it('with no active tab, ⌘W falls through to the host', () => {
      strips.workspace = fakeStrip([], null, null);
      unregister.push(replaceStrip('workspace', strips.workspace));
      mount({ claimWindowChords: true, isMac: true });
      outside.focus();

      const event = press(outside, { key: 'w', metaKey: true });

      expect(event.defaultPrevented).toBe(false);
      expect(strips.workspace.close).not.toHaveBeenCalled();
    });

    it('Ctrl+Tab wraps positionally from the last tab to the first', () => {
      mount({ claimWindowChords: true, isMac: true });
      outside.focus();

      const event = press(outside, { ctrlKey: true, key: 'Tab' });

      expect(event.defaultPrevented).toBe(true);
      expect(strips.workspace.activate).toHaveBeenCalledWith('files');
    });

    it('Ctrl+Shift+Tab wraps positionally from the first tab to the last', () => {
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { ctrlKey: true, key: 'Tab', shiftKey: true });

      expect(strips['assistant-threads'].activate).toHaveBeenCalledWith('t3');
    });

    it('⌘⇧T reopens the last closed tab of the focus-scoped strip', () => {
      mount({ claimWindowChords: true, isMac: true });
      browserInput.focus();

      const event = press(browserInput, { key: 'T', metaKey: true, shiftKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(strips.browser.reopenClosed).toHaveBeenCalledOnce();
      expect(strips.workspace.reopenClosed).not.toHaveBeenCalled();
    });

    it('reports an empty history as information, never as an error', async () => {
      const records: LogRecord[] = [];
      const release = addLogListener((record) => records.push(record));
      strips.workspace.reopenClosed.mockResolvedValueOnce(NO_CLOSED_TAB_OUTCOME);
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      try {
        press(outside, { ctrlKey: true, key: 'T', shiftKey: true });

        await vi.waitFor(() =>
          expect(toastSpy).toHaveBeenCalledWith({
            description: 'No closed tab to reopen',
            title: 'Reopen Closed Tab',
          })
        );
        expect(records.filter((record) => record.level === 'error')).toEqual([]);
      } finally {
        release();
      }
    });

    it('reports a reopen that could not restore its tab', async () => {
      strips.workspace.reopenClosed.mockResolvedValueOnce({
        error: '"notes.md" can no longer be reopened: its folder is not connected',
        ok: false,
      });
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      press(outside, { ctrlKey: true, key: 'T', shiftKey: true });

      await vi.waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            description: '"notes.md" can no longer be reopened: its folder is not connected',
            variant: 'destructive',
          })
        )
      );
    });

    it('reports a strip operation that throws synchronously, without an uncaught error', async () => {
      const uncaught = vi.fn();
      window.addEventListener('error', uncaught);
      strips.workspace.reopenClosed.mockImplementationOnce(() => {
        throw new Error('Cannot place tab "a.ts": it is not open');
      });
      strips.workspace.close.mockImplementationOnce(() => {
        throw new Error('store rejected the close');
      });
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      try {
        press(outside, { ctrlKey: true, key: 'T', shiftKey: true });
        press(outside, { ctrlKey: true, key: 'w' });

        await vi.waitFor(() =>
          expect(toastSpy.mock.calls.map(([toast]) => toast)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                description: 'Cannot place tab "a.ts": it is not open',
                title: 'Reopen Closed Tab',
                variant: 'destructive',
              }),
              expect.objectContaining({
                description: 'store rejected the close',
                title: 'Close Tab',
                variant: 'destructive',
              }),
            ])
          )
        );
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('error', uncaught);
      }
    });

    it('reports a close that rejected', async () => {
      strips.workspace.close.mockRejectedValueOnce(new Error('unknown tab b.ts'));
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      press(outside, { ctrlKey: true, key: 'w' });

      await vi.waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ description: 'unknown tab b.ts', variant: 'destructive' })
        )
      );
    });

    it('reports a reopen that threw', async () => {
      strips.workspace.reopenClosed.mockRejectedValueOnce(new Error('bridge down'));
      mount({ claimWindowChords: true, isMac: false });
      outside.focus();

      press(outside, { ctrlKey: true, key: 'T', shiftKey: true });

      await vi.waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ description: 'bridge down', variant: 'destructive' })
        )
      );
    });
  });

  describe('modal surfaces own their keys', () => {
    const surfaces: readonly [string, Record<string, string>][] = [
      ['a dialog (Radix sets the role, never aria-modal)', { role: 'dialog' }],
      ['an alert dialog', { role: 'alertdialog' }],
      ['an open menu', { role: 'menu' }],
    ];

    it.each(surfaces)('does not act or preventDefault with focus in %s', (_label, attributes) => {
      const surface = document.createElement('div');
      for (const [name, value] of Object.entries(attributes)) {
        surface.setAttribute(name, value);
      }
      const field = document.createElement('input');
      surface.append(field);
      document.body.append(surface);
      mount({ claimWindowChords: true, isMac: true });
      field.focus();

      try {
        const close = press(field, { key: 'w', metaKey: true });
        const cycle = press(field, CTRL_PAGE_DOWN);

        expect([close.defaultPrevented, cycle.defaultPrevented]).toEqual([false, false]);
        expect(strips.workspace.close).not.toHaveBeenCalled();
        expect(strips.workspace.activate).not.toHaveBeenCalled();
      } finally {
        surface.remove();
      }
    });
  });

  it('never claims a chord a nearer handler already handled', () => {
    mount({ claimWindowChords: true, isMac: false });
    outside.focus();
    outside.addEventListener('keydown', (event) => event.preventDefault(), { once: true });

    press(outside, CTRL_PAGE_DOWN);

    expect(strips.workspace.activate).not.toHaveBeenCalled();
  });

  it('ignores ⌘⌥→ off macOS and chords with extra modifiers', () => {
    mount({ claimWindowChords: true, isMac: false });
    outside.focus();

    const notMac = press(outside, { altKey: true, key: 'ArrowRight', metaKey: true });
    const extraShift = press(outside, { ctrlKey: true, key: 'PageDown', shiftKey: true });
    const extraAlt = press(outside, { altKey: true, ctrlKey: true, key: 'w' });

    expect([notMac, extraShift, extraAlt].map((event) => event.defaultPrevented)).toEqual([
      false,
      false,
      false,
    ]);
    expect(strips.workspace.activate).not.toHaveBeenCalled();
    expect(strips.workspace.close).not.toHaveBeenCalled();
  });

  function replaceStrip(id: TabChordStripId, strip: TabChordStrip): () => void {
    const index = (Object.keys(strips) as TabChordStripId[]).indexOf(id);
    unregister[index]?.();
    return registerTabChordStrip(id, strip);
  }
});

describe('registerTabChordStrip', () => {
  function errorRecords(run: () => void): LogRecord[] {
    const records: LogRecord[] = [];
    const release = addLogListener((record) => records.push(record));
    try {
      run();
    } finally {
      release();
    }
    return records.filter((record) => record.level === 'error');
  }

  it('logs a second live registration and keeps the first, which still routes', () => {
    const first = fakeStrip([], 'first', null);
    const second = fakeStrip([], 'second', null);
    const releaseFirst = registerTabChordStrip('workspace', first);
    let releaseSecond: () => void = () => undefined;
    try {
      const errors = errorRecords(() => {
        releaseSecond = registerTabChordStrip('workspace', second);
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/already registered/);
      expect(getTabChordStrip('workspace')).toBe(first);
      // The duplicate's release is a no-op: the first registration survives it.
      releaseSecond();
      expect(getTabChordStrip('workspace')).toBe(first);
    } finally {
      releaseFirst();
    }
    expect(getTabChordStrip('workspace')).toBeUndefined();
  });

  it('a stale release never removes a newer registration', () => {
    const first = fakeStrip([], null, null);
    const releaseFirst = registerTabChordStrip('browser', first);
    releaseFirst();
    const second = fakeStrip([], null, null);
    const releaseSecond = registerTabChordStrip('browser', second);
    releaseFirst();
    expect(getTabChordStrip('browser')).toBe(second);
    releaseSecond();
  });
});
