import type { ActionOutcome } from '@brainstrike/context-actions';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import {
  registerTabChordStrip,
  type TabChordStrip,
  type TabChordStripId,
} from '../tab-chord-registry';
import { useTabChords } from '../use-tab-chords';

interface FakeStrip extends TabChordStrip {
  readonly activate: ReturnType<typeof vi.fn<(id: string) => void>>;
  readonly close: ReturnType<typeof vi.fn<(id: string) => void>>;
  readonly reopenClosed: ReturnType<typeof vi.fn<() => Promise<ActionOutcome>>>;
}

function fakeStrip(
  ids: readonly string[],
  activeId: string | null,
  panel: HTMLElement | null
): FakeStrip {
  return {
    activate: vi.fn<(id: string) => void>(),
    close: vi.fn<(id: string) => void>(),
    getActiveId: () => activeId,
    getPanel: () => panel,
    getTabs: () => ids.map((id) => ({ id, label: id.toUpperCase() })),
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
      strips['assistant-threads'].close.mockImplementation(() => assistantInput.remove());
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
        // The previous thread's panel is hidden with the composer in it.
        assistantInput.hidden = true;
        assistantInput.blur();
        nextTab.setAttribute('aria-selected', 'true');
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
        assistantInput.blur();
        reopenedTab.setAttribute('aria-selected', 'true');
        return Promise.resolve({ ok: true });
      });
      mount({ claimWindowChords: true, isMac: true });
      assistantInput.focus();

      press(assistantInput, { key: 'T', metaKey: true, shiftKey: true });

      await vi.waitFor(() => expect(document.activeElement).toBe(reopenedTab));
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
  it('rejects a second live registration of the same strip', () => {
    const release = registerTabChordStrip('workspace', fakeStrip([], null, null));
    try {
      expect(() => registerTabChordStrip('workspace', fakeStrip([], null, null))).toThrow(
        /already registered/
      );
    } finally {
      release();
    }
  });

  it('a stale release never removes a newer registration', () => {
    const first = fakeStrip([], null, null);
    const releaseFirst = registerTabChordStrip('browser', first);
    releaseFirst();
    const releaseSecond = registerTabChordStrip('browser', fakeStrip([], null, null));
    releaseFirst();
    expect(() => registerTabChordStrip('browser', fakeStrip([], null, null))).toThrow(
      /already registered/
    );
    releaseSecond();
  });
});
