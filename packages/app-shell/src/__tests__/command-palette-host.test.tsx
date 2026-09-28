import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));
const noHandlers = {};
vi.mock('../use-global-command-handlers', () => ({
  useGlobalCommandHandlers: () => noHandlers,
}));

import { CommandPaletteHost } from '../command-palette-host';
import { registerTabChordStrip, type TabChordStrip } from '../tab-chords/tab-chord-registry';
import { useTabChords } from '../tab-chords/use-tab-chords';

/** The real chord router with the desktop capability, beside the palette. */
function DesktopChordRouter(): null {
  useTabChords({ claimWindowChords: true, isMac: false });
  return null;
}

// Radix Dialog + cmdk rely on DOM APIs jsdom does not implement.
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
window.HTMLElement.prototype.scrollIntoView = vi.fn();

function fakeStrip(
  ids: readonly string[],
  activeId: string,
  panel: HTMLElement | null,
  closedTabs = 0
) {
  return {
    activate: vi.fn<(id: string) => void>(),
    close: vi.fn<(id: string) => void>(),
    getActiveId: () => activeId,
    getPanel: () => panel,
    getTabs: () => ids.map((id) => ({ id, label: `Tab ${id}` })),
    hasClosedTabs: () => closedTabs > 0,
    reopenClosed: () => Promise.resolve({ ok: true as const }),
  } satisfies TabChordStrip;
}

/** Ctrl+K: jsdom reports a non-mac platform. */
function openPalette(from: Element): void {
  fireEvent.keyDown(from, { ctrlKey: true, key: 'k' });
}

describe('CommandPaletteHost tab commands (BST-1842)', () => {
  let panel: HTMLElement;
  let composer: HTMLTextAreaElement;
  let assistant: ReturnType<typeof fakeStrip>;
  let workspace: ReturnType<typeof fakeStrip>;
  let releases: (() => void)[];

  beforeEach(() => {
    panel = document.createElement('div');
    composer = document.createElement('textarea');
    panel.append(composer);
    document.body.append(panel);
    assistant = fakeStrip(['t1', 't2'], 't1', panel, 1);
    workspace = fakeStrip(['files', 'a.ts'], 'files', null);
    releases = [
      registerTabChordStrip('assistant-threads', assistant),
      registerTabChordStrip('workspace', workspace),
    ];
  });

  afterEach(() => {
    for (const release of releases) {
      release();
    }
    panel.remove();
  });

  it('acts on the strip whose panel held focus when the palette opened', async () => {
    render(<CommandPaletteHost />);
    composer.focus();

    openPalette(composer);
    fireEvent.click(await screen.findByRole('option', { name: /^Next Tab/ }));

    await waitFor(() => expect(assistant.activate).toHaveBeenCalledExactlyOnceWith('t2'));
    expect(workspace.activate).not.toHaveBeenCalled();
  });

  it('offers Reopen Closed Tab only when the scoped strip has a closed tab', async () => {
    render(<CommandPaletteHost />);

    composer.focus();
    openPalette(composer);
    expect(await screen.findByRole('option', { name: /^Reopen Closed Tab/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    // Focus in no panel scopes to the workspace, whose history is empty.
    (document.activeElement as HTMLElement | null)?.blur();
    openPalette(document.body);
    expect(await screen.findByRole('option', { name: /^Next Tab/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^Reopen Closed Tab/ })).toBeNull();
  });

  it('Ctrl+W typed in the open palette leaves the workspace tab behind it open', async () => {
    render(
      <>
        <CommandPaletteHost />
        <DesktopChordRouter />
      </>
    );
    openPalette(document.body);
    const input = await screen.findByRole('combobox');
    input.focus();

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'w',
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(workspace.close).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('Go to Tab… lists the workspace strip when focus was in no panel', async () => {
    render(<CommandPaletteHost />);

    openPalette(document.body);
    fireEvent.click(await screen.findByRole('option', { name: /^Go to Tab…/ }));
    const listbox = await screen.findByRole('listbox');
    await waitFor(() =>
      expect(
        within(listbox)
          .getAllByRole('option')
          .map((option) => option.textContent)
      ).toEqual(['Tab files', 'Tab a.ts'])
    );
    fireEvent.click(within(listbox).getByRole('option', { name: 'Tab a.ts' }));

    await waitFor(() => expect(workspace.activate).toHaveBeenCalledExactlyOnceWith('a.ts'));
    expect(assistant.activate).not.toHaveBeenCalled();
  });
});
